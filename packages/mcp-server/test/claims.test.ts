import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { RemoraHub } from "../src/hub.js";
import { ClaimStore } from "../src/claims.js";
import { tab_claim, tab_release, tabs_list, remora_status, navigate, click } from "../src/tools/handlers.js";
import type { Ctx } from "../src/tools/handlers.js";

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

/** Fake extension answering a fixed tab list; records received methods. */
async function fakeExtension(port: number, opts?: { activeId?: number; received?: string[] }) {
  const ext = new WebSocket(`ws://127.0.0.1:${port}/remora?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    ext.once("open", resolve);
    ext.once("error", reject);
  });
  ext.send(JSON.stringify({ event: "hello", payload: { version: "0.1.0", protocol: 1, tabCount: 2 } }));
  const tabs = [
    { id: 1, windowId: 1, title: "A", url: "https://a.test", active: (opts?.activeId ?? 1) === 1, pinned: false },
    { id: 2, windowId: 1, title: "B", url: "https://b.test", active: (opts?.activeId ?? 1) === 2, pinned: false },
  ];
  ext.on("message", (raw) => {
    let frame: { id?: string; method?: string; params?: unknown; notification?: string };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.notification) return;
    if (!frame.id) return;
    opts?.received?.push(String(frame.method));
    if (frame.method === "tabs.list") {
      ext.send(JSON.stringify({ id: frame.id, ok: true, result: tabs }));
    } else if (frame.method === "tabs.create") {
      ext.send(JSON.stringify({
        id: frame.id, ok: true,
        result: { id: 9, windowId: 1, title: "New", url: "https://new.test", active: true, pinned: false },
      }));
    } else {
      ext.send(JSON.stringify({ id: frame.id, ok: true, result: { ok: true } }));
    }
  });
  return ext;
}

describe("ClaimStore", () => {
  it("claim / check / release cycle", () => {
    const store = new ClaimStore();
    expect(store.check(1, "a")).toEqual({ allowed: true });
    store.claim(1, "a", "ZCode aaa", "testing");
    const verdict = store.check(1, "b");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.claim.ownerLabel).toBe("ZCode aaa");
    expect(store.check(1, "a")).toEqual({ allowed: true });
    expect(() => store.release(1, "b")).toThrow("claimed");
    expect(store.release(1, "a")).toBe(true);
    expect(store.release(1, "a")).toBe(false);
    expect(store.check(1, "b")).toEqual({ allowed: true });
  });

  it("prunes dead tabs and clears one owner's claims", () => {
    const store = new ClaimStore();
    store.claim(1, "a");
    store.claim(2, "b");
    expect(store.prune([1])).toEqual([2]);
    expect(store.clearMine("a")).toEqual([1]);
    expect(store.list()).toEqual([]);
  });
});

describe("tab claims across sessions", () => {
  it("second session is blocked from a claimed tab with TAB_CLAIMED", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa", ownerLabel: "ZCode aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb", ownerLabel: "ZCode bbb" }));
    await h2.start();
    const ext = await fakeExtension(port);
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);

    await tab_claim({ hub: h1 }, { tabId: 1, note: "task A" });
    await expect(navigate({ hub: h2 }, { tabId: 1, url: "https://evil.test" }))
      .rejects.toThrow(/claimed by ZCode aaa/);
    // Owner still passes; other tab is free for the second session.
    await navigate({ hub: h1 }, { tabId: 1, url: "https://a.test/ok" });
    await click({ hub: h2 }, { tabId: 2, ref: "e1" });

    await tab_release({ hub: h1 }, { tabId: 1 });
    await navigate({ hub: h2 }, { tabId: 1, url: "https://a.test/now-free" });

    ext.close();
  });

  it("implicit active-tab mutations are blocked when the active tab is claimed", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa", ownerLabel: "ZCode aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb", ownerLabel: "ZCode bbb" }));
    await h2.start();
    const ext = await fakeExtension(port, { activeId: 1 });
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);

    await tab_claim({ hub: h1 }, { tabId: 1 });
    await expect(navigate({ hub: h2 }, { url: "https://evil.test" }))
      .rejects.toThrow(/TAB_CLAIMED|claimed by/);

    ext.close();
  });

  it("tabs_list marks claims and tab_create auto-claims", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa", ownerLabel: "ZCode aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb", ownerLabel: "ZCode bbb" }));
    await h2.start();
    const ext = await fakeExtension(port);
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);

    await tab_claim({ hub: h1 }, { tabId: 1, note: "task A" });
    const listed = (await tabs_list({ hub: h2 } as Ctx)) as Array<Record<string, unknown>>;
    const row = listed.find((t) => t.id === 1);
    expect(row?.claimedBy).toBe("ZCode aaa");
    expect(row?.claimNote).toBe("task A");
    expect(row?.claimedByMe).toBe(false);

    const created = (await import("../src/tools/handlers.js").then((m) =>
      m.tab_create({ hub: h2 } as Ctx, { url: "https://new.test" }),
    )) as Array<Record<string, unknown>>;
    expect(created[0]?.claimedByMe).toBe(true);

    const status = (await remora_status({ hub: h2 } as Ctx)) as { claims: Array<{ tabId: number }> };
    expect(status.claims.map((c) => c.tabId).sort()).toEqual([1, 9]);

    ext.close();
  });

  it("claims die with the tab and with the owning session", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa", ownerLabel: "ZCode aaa" }));
    await h1.start();
    const ext = await fakeExtension(port);
    for (let i = 0; i < 40 && !h1.connected; i++) await delay(50);

    await tab_claim({ hub: h1 }, { tabId: 1 });
    ext.send(JSON.stringify({ event: "tab_closed", payload: { tabId: 1 } }));
    for (let i = 0; i < 40 && h1.listClaims().length > 0; i++) await delay(50);
    expect(h1.listClaims()).toEqual([]);

    await tab_claim({ hub: h1 }, { tabId: 2 });
    await h1.stop();
    expect(h1.listClaims()).toEqual([]);
    ext.close();
  });

  it("peer receives claim broadcasts without polling", async () => {
    const port = await freePort();
    const h1 = track(new RemoraHub({ port, token: TOKEN, agentId: "aaa", ownerLabel: "ZCode aaa" }));
    await h1.start();
    const h2 = track(new RemoraHub({ port, token: TOKEN, agentId: "bbb", ownerLabel: "ZCode bbb" }));
    await h2.start();
    const ext = await fakeExtension(port);
    for (let i = 0; i < 40 && !h2.connected; i++) await delay(50);

    await tab_claim({ hub: h1 }, { tabId: 2 });
    for (let i = 0; i < 40 && h2.listClaims().length === 0; i++) await delay(50);
    expect(h2.listClaims().map((c) => c.tabId)).toEqual([2]);

    ext.close();
  });
});
