import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { tokenProtocols } from "@remora/protocol";
import { RemoraHub } from "../src/hub.js";

const TOKEN = "test-token-0123456789abcdef";

/** Find a free port so parallel test runs never collide. */
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

describe("hub multi-session sharing", () => {
  it("first hub owns the port, second attaches as a peer", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();
    expect(primary.isPrimary).toBe(true);

    const secondary = track(new RemoraHub({ port, token: TOKEN }));
    await secondary.start();
    expect(secondary.isPrimary).toBe(false);
    expect(secondary.connected).toBe(false);
  });

  it("peer forwards requests to the extension through the primary", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const secondary = track(new RemoraHub({ port, token: TOKEN }));
    await secondary.start();

    // Stand in for the Chrome extension.
    const ext = new WebSocket(`ws://127.0.0.1:${port}/remora`, tokenProtocols(TOKEN));
    await new Promise((resolve, reject) => {
      ext.once("open", resolve);
      ext.once("error", reject);
    });
    ext.send(JSON.stringify({ event: "hello", payload: { version: "0.1.0", protocol: 1, tabCount: 2 } }));
    ext.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (!frame.id) return;
      ext.send(
        JSON.stringify({ id: frame.id, ok: true, result: [{ id: 1, url: "https://example.com", active: true }] }),
      );
    });

    for (let i = 0; i < 40 && !secondary.connected; i++) await delay(50);
    expect(secondary.connected).toBe(true);
    expect(secondary.extension?.tabCount).toBe(2);

    const tabs = await secondary.request<Array<{ url: string }>>("tabs.list", {});
    expect(tabs[0]?.url).toBe("https://example.com");

    ext.close();
  });

  it("peer takes the port over when the primary stops", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const secondary = track(new RemoraHub({ port, token: TOKEN }));
    await secondary.start();
    expect(secondary.isPrimary).toBe(false);

    await primary.stop();

    for (let i = 0; i < 60 && !secondary.isPrimary; i++) await delay(100);
    expect(secondary.isPrimary).toBe(true);
  });

  it("rejects a peer connection with the wrong token", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const bad = new WebSocket(`ws://127.0.0.1:${port}/remora-control`, tokenProtocols("wrong"));
    const code = await new Promise<number>((resolve) => {
      bad.on("close", (c) => resolve(c));
      bad.on("error", () => undefined);
    });
    expect(code).toBe(4401);
  });

  it("rejects a token passed in the URL query instead of the subprotocol", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const legacy = new WebSocket(`ws://127.0.0.1:${port}/remora?token=${TOKEN}`);
    const code = await new Promise<number>((resolve) => {
      legacy.on("close", (c) => resolve(c));
      legacy.on("error", () => undefined);
    });
    expect(code).toBe(4403);
  });

  it("accepts the Chrome extension by origin, without a token", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/remora`, ["remora"], {
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    });
    const first = await new Promise<{ event?: string }>((resolve, reject) => {
      ext.once("message", (raw) => resolve(JSON.parse(String(raw))));
      ext.once("close", (c) => reject(new Error(`closed ${c}`)));
    });
    expect(first.event).toBe("welcome");
    ext.close();
  });

  it("refuses web pages and unlisted extensions, even with the token", async () => {
    const port = await freePort();
    const primary = track(
      new RemoraHub({ port, token: TOKEN, extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] }),
    );
    await primary.start();

    const closeCode = (origin: string, path = "/remora") =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, tokenProtocols(TOKEN), { origin });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => undefined);
      });
    expect(await closeCode("https://evil.example")).toBe(4403);
    expect(await closeCode("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba")).toBe(4403);
    expect(await closeCode("https://evil.example", "/remora-control")).toBe(4401);
  });

  it("welcomes the extension and answers pings", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/remora`, tokenProtocols(TOKEN));
    const frames: Array<{ event?: string; payload?: { t?: number; entry?: string } }> = [];
    ext.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ext.once("open", resolve));
    ext.send(JSON.stringify({ event: "ping", payload: { t: 42 } }));
    for (let i = 0; i < 40 && frames.length < 2; i++) await delay(25);

    expect(frames[0]?.event).toBe("welcome");
    // The popup builds the MCP config from this path, so it must be absolute.
    expect(frames[0]?.payload?.entry).toMatch(/[\\/]index\.js$/);
    expect(isAbsolute(frames[0]!.payload!.entry!)).toBe(true);
    expect(frames[1]).toEqual({ event: "pong", payload: { t: 42 } });
    ext.close();
  });

  it("explains a token mismatch between MCP processes", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const other = track(new RemoraHub({ port, token: "another-token-0123456789" }));
    await expect(other.start()).rejects.toThrow(/uses a different config file/);
  });

  it("fails loudly when the port is held by a foreign server", async () => {
    const port = await freePort();
    const foreign = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => foreign.once("listening", () => resolve()));

    const hub = track(new RemoraHub({ port, token: TOKEN }));
    await expect(hub.start()).rejects.toThrow(/does not speak the Remora control protocol/);

    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }, 15000);
});

describe("hub multi-profile extensions", () => {
  async function fakeExtension(port: number, instanceId: string, label: string, focused: boolean) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remora`, tokenProtocols(TOKEN));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const methods: string[] = [];
    const notifications: string[] = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        id?: string;
        method?: string;
        notification?: string;
      };
      if (frame.notification) {
        notifications.push(frame.notification);
        return;
      }
      if (!frame.id) return;
      methods.push(frame.method ?? "");
      ws.send(JSON.stringify({ id: frame.id, ok: true, result: { from: label } }));
    });
    ws.send(
      JSON.stringify({
        event: "hello",
        payload: { version: "0.1.0", protocol: 1, tabCount: 1, instanceId, focused },
      }),
    );
    return { ws, methods, notifications };
  }

  async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await delay(25);
    }
    throw new Error("timed out waiting for condition");
  }

  it("serves two Chrome profiles side by side and binds sessions to the focused one", async () => {
    const port = await freePort();
    const hub = track(new RemoraHub({ port, token: TOKEN }));
    await hub.start();

    const agentA = track(new RemoraHub({ port, token: TOKEN }));
    await agentA.start();
    const agentB = track(new RemoraHub({ port, token: TOKEN }));
    await agentB.start();

    const extA = await fakeExtension(port, "profile-a", "A", true);
    const extB = await fakeExtension(port, "profile-b", "B", false);
    await waitFor(() => agentA.extension?.instances === 2);
    expect(extA.ws.readyState).toBe(WebSocket.OPEN);
    expect(extB.ws.readyState).toBe(WebSocket.OPEN);

    // A fresh session lands in the focused profile and stays there.
    const first = await agentA.request<{ from: string }>("tabs.list", {});
    expect(first.from).toBe("A");
    expect(extA.methods).toContain("tabs.list");

    // The user switches to the other Chrome window: a new session follows.
    extB.ws.send(JSON.stringify({ event: "focus", payload: { focused: true } }));
    await delay(100);
    const other = await agentB.request<{ from: string }>("tabs.list", {});
    expect(other.from).toBe("B");

    // The first session must not jump profiles when focus moves again.
    extA.ws.send(JSON.stringify({ event: "focus", payload: { focused: true } }));
    const again = await agentA.request<{ from: string }>("tabs.list", {});
    expect(again.from).toBe("A");

    extA.ws.close();
    extB.ws.close();
  });

  it("replaces the stale socket of the same profile and keeps its session binding", async () => {
    const port = await freePort();
    const hub = track(new RemoraHub({ port, token: TOKEN }));
    await hub.start();
    const agent = track(new RemoraHub({ port, token: TOKEN }));
    await agent.start();

    const old = await fakeExtension(port, "profile-a", "old", true);
    const first = await agent.request<{ from: string }>("tabs.list", {});
    expect(first.from).toBe("old");

    const closed = new Promise<number>((resolve) => old.ws.once("close", (code) => resolve(code)));
    const fresh = await fakeExtension(port, "profile-a", "fresh", false);
    expect(await closed).toBe(4000);

    const after = await agent.request<{ from: string }>("tabs.list", {});
    expect(after.from).toBe("fresh");
    fresh.ws.close();
  });

  it("broadcasts session notifications to every connected profile", async () => {
    const port = await freePort();
    const hub = track(new RemoraHub({ port, token: TOKEN }));
    await hub.start();

    const extA = await fakeExtension(port, "profile-a", "A", true);
    const extB = await fakeExtension(port, "profile-b", "B", false);
    await delay(100);

    hub.notify("session.end", { agentId: "agent-x" });
    await waitFor(() => extA.notifications.includes("session.end") && extB.notifications.includes("session.end"));

    extA.ws.close();
    extB.ws.close();
  });
});
