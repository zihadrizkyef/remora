import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import {
  OUT_OF_GROUP_MESSAGE,
  TAB_GROUP_NONE,
  checkTab,
  resolveImplicitTab,
  tokenProtocols,
  type OwnedGroup,
  type TabRef,
} from "@remora/protocol";
import { RemoraHub } from "../src/hub.js";
import { click, remora_status, snapshot, tab_create, tabs_list } from "../src/tools/handlers.js";

const TOKEN = "test-token-0123456789abcdef";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const hubs: RemoraHub[] = [];
function track(hub: RemoraHub): RemoraHub {
  hubs.push(hub);
  return hub;
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop().catch(() => undefined)));
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  id?: string;
  method?: string;
  params?: { tabId?: number };
  agentId?: string;
  notification?: string;
  payload?: { agentId?: string };
}

/**
 * Stand-in extension that enforces groups with the shared rulebook, the way
 * background.ts does. Tab 1 is the user's (no group); tab 7 belongs to agent
 * "bbb". tabs.list deliberately leaks every row so the server's own filter
 * is exercised.
 */
async function fakeExtension(port: number) {
  const frames: Frame[] = [];
  const groups: OwnedGroup[] = [{ groupId: 70, agentId: "bbb", createdAt: 0, hosts: [] }];
  const tabs: TabRef[] = [
    { id: 1, groupId: TAB_GROUP_NONE, windowId: 1, active: true },
    { id: 7, groupId: 70, windowId: 1 },
  ];
  let nextTab = 10;
  let nextGroup = 100;
  const ext = new WebSocket(`ws://127.0.0.1:${port}/remora`, tokenProtocols(TOKEN));
  await new Promise((resolve, reject) => {
    ext.once("open", resolve);
    ext.once("error", reject);
  });
  ext.send(JSON.stringify({ event: "hello", payload: { version: "0.1.0", protocol: 1, tabCount: 2 } }));
  const reply = (id: string, result: unknown) => ext.send(JSON.stringify({ id, ok: true, result }));
  const fail = (id: string) =>
    ext.send(JSON.stringify({ id, ok: false, error: { code: "OUT_OF_GROUP", message: OUT_OF_GROUP_MESSAGE } }));
  ext.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as Frame;
    frames.push(f);
    if (!f.id || !f.method) return;
    const agent = f.agentId ?? "";
    const row = (t: TabRef) => ({ id: t.id, windowId: 1, title: `T${t.id}`, url: "https://x.test", active: !!t.active, pinned: false, groupId: t.groupId });
    switch (f.method) {
      case "tabs.list":
        return reply(f.id, tabs.map(row));
      case "tabs.create": {
        let g = groups.find((x) => x.agentId === agent);
        if (!g) groups.push((g = { groupId: nextGroup++, agentId: agent, createdAt: 0, hosts: [] }));
        const t = { id: nextTab++, groupId: g.groupId, windowId: 1 };
        tabs.push(t);
        g.workingTabId = t.id;
        return reply(f.id, row(t));
      }
      case "tabs.resolve": {
        const tabId = f.params?.tabId;
        const r = tabId === undefined
          ? resolveImplicitTab(tabs, agent, groups)
          : checkTab(tabs.find((t) => t.id === tabId), agent, groups);
        if (!r.ok) return fail(f.id);
        return reply(f.id, { tabId: r.tabId, groupId: tabs.find((t) => t.id === r.tabId)!.groupId });
      }
      case "session.info": {
        const g = groups.find((x) => x.agentId === agent);
        const mine = tabs.filter((t) => g && t.groupId === g.groupId);
        return reply(f.id, { groupId: g?.groupId ?? null, tabIds: mine.map((t) => t.id), hiddenTabCount: tabs.length - mine.length });
      }
      default:
        return reply(f.id, {});
    }
  });
  return { ext, frames };
}

describe("tab group isolation (server side)", () => {
  it("every request carries the calling session's agentId, also through a peer", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb" }));
    await h2.start();
    const { ext, frames } = await fakeExtension(port);
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);

    await h1.request("tabs.list", {});
    await h2.request("tabs.list", {});
    const agents = frames.filter((f) => f.method === "tabs.list").map((f) => f.agentId);
    expect(agents).toEqual(["aaa", "bbb"]);
    ext.close();
  });

  it("without a group tab, implicit calls fail and point to tab_create", async () => {
    const port = await freePort();
    const h = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h.start();
    const { ext, frames } = await fakeExtension(port);
    await expect(click({ hub: h }, { ref: "e1" })).rejects.toThrow(/OUT_OF_GROUP.*tab_create/);
    // The click itself never reached the extension.
    expect(frames.some((f) => f.method === "click")).toBe(false);
    ext.close();
  });

  it("a user tab or another session's tab is refused with OUT_OF_GROUP", async () => {
    const port = await freePort();
    const h = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h.start();
    const { ext } = await fakeExtension(port);
    await tab_create({ hub: h }, { url: "https://x.test" });
    await expect(snapshot({ hub: h }, { tabId: 1 })).rejects.toThrow(/OUT_OF_GROUP/);
    await expect(snapshot({ hub: h }, { tabId: 7 })).rejects.toThrow(/OUT_OF_GROUP/);
    ext.close();
  });

  it("implicit calls land on the session's working tab, not the active tab", async () => {
    const port = await freePort();
    const h = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h.start();
    const { ext, frames } = await fakeExtension(port);
    const tab = (await tab_create({ hub: h }, {})) as { id: number };
    await click({ hub: h }, { ref: "e1" });
    const sent = frames.find((f) => f.method === "click");
    expect(sent?.params?.tabId).toBe(tab.id);
    ext.close();
  });

  it("tabs_list shows only the session's group even if the extension over-shares", async () => {
    const port = await freePort();
    const h = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h.start();
    const { ext } = await fakeExtension(port);
    const tab = (await tab_create({ hub: h }, {})) as { id: number };
    const rows = (await tabs_list({ hub: h })) as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toEqual([tab.id]);
    const status = (await remora_status({ hub: h })) as { hiddenTabs: string; group: { tabCount: number } };
    expect(status.hiddenTabs).toBe("2 tab lain disembunyikan");
    expect(status.group.tabCount).toBe(1);
    ext.close();
  });

  it("a stopping session tells the extension to release its group", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb" }));
    await h2.start();
    const { ext, frames } = await fakeExtension(port);
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);
    await h2.stop();
    for (let i = 0; i < 40 && !frames.some((f) => f.notification === "session.end"); i++) await delay(50);
    expect(frames.filter((f) => f.notification === "session.end").map((f) => f.payload?.agentId)).toContain("bbb");
    ext.close();
  });
});
