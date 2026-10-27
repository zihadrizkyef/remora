import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
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
    expect(code).toBe(4401);
  });

  it("welcomes the extension with the token id and answers pings", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/remora`, tokenProtocols(TOKEN));
    const frames: Array<{ event?: string; payload?: { tokenId?: string; t?: number } }> = [];
    ext.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ext.once("open", resolve));
    ext.send(JSON.stringify({ event: "ping", payload: { t: 42 } }));
    for (let i = 0; i < 40 && frames.length < 2; i++) await delay(25);

    expect(frames[0]?.event).toBe("welcome");
    expect(frames[0]?.payload?.tokenId).toBe(primary.tokenId);
    expect(primary.tokenId).toMatch(/^[0-9a-f]{8}$/);
    expect(frames[1]).toEqual({ event: "pong", payload: { t: 42 } });
    ext.close();
  });

  it("explains a token mismatch between MCP processes", async () => {
    const port = await freePort();
    const primary = track(new RemoraHub({ port, token: TOKEN }));
    await primary.start();

    const other = track(new RemoraHub({ port, token: "another-token-0123456789" }));
    await expect(other.start()).rejects.toThrow(/uses a different token/);
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
