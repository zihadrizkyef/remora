import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  ExtensionHelloPayloadSchema,
  NavigatedPayloadSchema,
  SessionEndPayloadSchema,
  TabClosedPayloadSchema,
  TaskEndPayloadSchema,
  TaskSnapshotSchema,
  UploadProgressPayloadSchema,
  WS_CLOSE,
  WS_HEARTBEAT_MS,
  WS_PATH,
  WS_REQUEST_TIMEOUT_MS,
  WS_STALE_MS,
  WS_SUBPROTOCOL,
  WireError,
  WireMethodName,
  parseWireFrame,
  tokenFingerprint,
  tokenFromProtocols,
  tokenProtocols,
  validateMethodParams,
} from "@remora/protocol";
import { markActive, markClosed } from "./activity.js";
import { TaskTracker, type TaskEnded, type TaskSnapshot } from "./tasks.js";

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * WebSocket hub: the MCP server listens on 127.0.0.1 and the Chrome
 * extension connects as a client. Exactly one extension is served at a
 * time (the newest connection wins); requests time out and fail fast
 * with typed wire errors so tools never hang forever.
 *
 * MCP clients spawn one server process per session and every one of them
 * wants the same fixed port. Only the first can bind it, so the others
 * attach to that hub over a localhost control channel and forward requests
 * through it. If the owning process exits, an attached process takes the
 * port back over.
 */

/** Path used by peer MCP processes; the extension never uses it. */
export const CONTROL_PATH = "/remora-control";

export interface ExtensionInfo {
  version: string;
  protocol: number;
  tabCount: number;
  connectedAt: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: WireError) => void;
  timer: NodeJS.Timeout;
}

type HubMode = "server" | "peer";

function isAddressInUse(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EADDRINUSE" || /EADDRINUSE/.test(String((err as Error | undefined)?.message ?? ""));
}

const PEER_GONE_GRACE_MS = 5000;

const SERVER_VERSION = "0.1.0";

class BadTokenError extends Error {}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RemoraHub {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private lastSeen = 0;
  private info: ExtensionInfo | null = null;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;

  /** Stable id for this MCP process; the extension scopes tab access to its group. */
  readonly agentId: string;
  /** Short human label for logs and status. */
  readonly ownerLabel: string;
  readonly tasks = new TaskTracker((ended) => this.emitTaskEnd(ended));

  /** This session's Remora tab group as last reported by the extension. */
  groupId: number | undefined;

  private mode: HubMode = "server";
  private control: WebSocket | null = null;
  private peers = new Set<WebSocket>();
  /** Agent id each attached peer speaks for, learned from its requests. */
  private peerAgents = new Map<WebSocket, string>();
  private peerState: { connected: boolean; extension: ExtensionInfo | null } = {
    connected: false,
    extension: null,
  };
  private stopped = false;
  /** Fingerprint of the hub token, shown to the user to spot pairing mismatches. */
  tokenId = "";
  private reattachTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { port: number; token: string; agentId?: string; ownerLabel?: string }) {
    this.log = (msg) => console.error(`[remora hub] ${msg}`);
    this.agentId = opts.agentId ?? `agent-${randomUUID().slice(0, 8)}`;
    this.ownerLabel = opts.ownerLabel ?? `agent ${this.agentId.slice(-6)}`;
  }

  get connected(): boolean {
    if (this.mode === "peer") return this.peerState.connected;
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get extension(): ExtensionInfo | null {
    return this.mode === "peer" ? this.peerState.extension : this.info;
  }

  /** True when this process owns the port instead of forwarding to another hub. */
  get isPrimary(): boolean {
    return this.mode === "server";
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.tokenId = await tokenFingerprint(this.opts.token);
    try {
      await this.startServer();
      this.log(`listening on 127.0.0.1:${this.opts.port}${WS_PATH}`);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
      this.log(`port ${this.opts.port} already in use; attaching to the running hub`);
      await this.attach();
    }
  }

  async stop(): Promise<void> {
    // Before teardown, so the notifications can still reach the extension.
    this.tasks.end("aborted");
    this.notify("session.end", { agentId: this.agentId });
    this.stopped = true;
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.failAllPending({ code: "INTERNAL", message: "hub shutting down" });
    this.control?.close();
    this.control = null;
    for (const peer of this.peers) {
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.socket?.close();
    this.socket = null;
    this.info = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  // -- server mode ----------------------------------------------------------

  private async startServer(): Promise<void> {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.opts.port,
      // Browsers drop the connection unless the server echoes one offered
      // protocol; answer with the plain name, never the token entry.
      handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          wss.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          wss.off("listening", onListening);
          reject(err);
        };
        wss.once("listening", onListening);
        wss.once("error", onError);
      });
    } catch (err) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      throw err;
    }

    this.wss = wss;
    this.mode = "server";
    wss.on("connection", (ws, req) =>
      this.handleConnection(ws, req.url ?? "", tokenFromProtocols(req.headers["sec-websocket-protocol"])),
    );
    wss.on("error", (err) => this.log(`server error: ${String(err)}`));
    this.heartbeat = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // A suspended or crashed worker never sends a close frame; drop the
      // dead link so the next tool call fails fast with NO_EXTENSION.
      if (Date.now() - this.lastSeen > WS_STALE_MS) {
        this.log("extension silent too long, dropping link");
        ws.close(WS_CLOSE.STALE, "stale");
        setTimeout(() => ws.terminate(), 1000).unref?.();
        return;
      }
      ws.send(JSON.stringify({ event: "heartbeat" }));
    }, WS_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private handleConnection(ws: WebSocket, url: string, token: string | null): void {
    const parsed = new URL(url, "http://localhost");
    if (token === null || !sameToken(token, this.opts.token)) {
      this.log(`rejected ${parsed.pathname} connection: token mismatch (hub token #${this.tokenId})`);
      ws.close(WS_CLOSE.BAD_TOKEN, "bad token");
      return;
    }
    if (parsed.pathname === CONTROL_PATH) {
      this.handlePeer(ws);
      return;
    }
    if (parsed.pathname !== WS_PATH) {
      this.log(`rejected connection on unknown path ${parsed.pathname}`);
      ws.close(WS_CLOSE.UNKNOWN_PATH, "unknown path");
      return;
    }
    if (this.socket) {
      this.log("replacing previous extension connection");
      try {
        this.socket.close(WS_CLOSE.REPLACED, "replaced");
      } catch {
        /* ignore */
      }
      this.failAllPending({ code: "INTERNAL", message: "extension reconnected" });
    }
    this.socket = ws;
    this.lastSeen = Date.now();
    this.log("extension connected, waiting for hello");
    ws.send(JSON.stringify({ event: "welcome", payload: { server: SERVER_VERSION, tokenId: this.tokenId } }));
    ws.on("message", (data) => {
      if (this.socket === ws) this.lastSeen = Date.now();
      this.handleMessage(String(data));
    });
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.info = null;
        this.log("extension disconnected");
        this.failAllPending({ code: "NO_EXTENSION", message: "extension disconnected" });
        this.broadcastState();
      }
    });
    ws.on("error", (err) => this.log(`socket error: ${String(err)}`));
  }

  private handleMessage(raw: string): void {
    let frame;
    try {
      frame = parseWireFrame(raw);
    } catch (err) {
      this.log(`dropping malformed frame: ${String(err)}`);
      return;
    }
    if (frame.kind === "response") {
      this.settle(frame.value.id, frame.value.ok, frame.value.result, frame.value.error);
      return;
    }
    if (frame.kind === "event") {
      this.handleEvent(frame.value.event, frame.value.payload);
      return;
    }
    this.log(`ignoring unexpected frame kind: ${frame.kind}`);
  }

  private settle(id: string, ok: boolean, result: unknown, error?: WireError): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(error ?? { code: "INTERNAL", message: "empty error" });
  }

  private handleEvent(event: string, payload: unknown): void {
    switch (event) {
      case "hello": {
        const parsed = ExtensionHelloPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          this.log("bad hello payload, closing");
          this.socket?.close(WS_CLOSE.BAD_HELLO, "bad hello");
          return;
        }
        this.info = { ...parsed.data, connectedAt: Date.now() };
        this.log(`hello from extension v${parsed.data.version} (${parsed.data.tabCount} tabs)`);
        this.broadcastState();
        break;
      }
      case "ping": {
        this.socket?.send(JSON.stringify({ event: "pong", payload }));
        break;
      }
      case "tab_closed": {
        const parsed = TabClosedPayloadSchema.safeParse(payload);
        if (parsed.success) this.onTabClosed(parsed.data.tabId);
        break;
      }
      case "navigated": {
        const parsed = NavigatedPayloadSchema.safeParse(payload);
        if (parsed.success) {
          const target = parsed.data.title || parsed.data.url;
          markActive(parsed.data.tabId, "navigated", target);
          this.broadcastToPeers({
            event: "activity",
            payload: { tabId: parsed.data.tabId, action: "navigated", target },
          });
        }
        break;
      }
      case "upload_progress": {
        const parsed = UploadProgressPayloadSchema.safeParse(payload);
        if (parsed.success) {
          this.log(
            `upload ${parsed.data.transferId}: ${parsed.data.receivedBytes}/${parsed.data.totalBytes} bytes`,
          );
        }
        break;
      }
      default:
        this.log(`unknown event: ${event}`);
    }
  }

  // -- peer MCP processes (primary side) ------------------------------------

  private handlePeer(ws: WebSocket): void {
    this.peers.add(ws);
    this.log("peer MCP process attached");
    this.sendState(ws);

    ws.on("message", (data) => {
      let frame;
      try {
        frame = parseWireFrame(String(data));
      } catch {
        return;
      }
      if (frame.kind === "request") {
        const { id, method, params, agentId } = frame.value;
        if (!agentId) {
          ws.send(JSON.stringify({ id, ok: false, error: { code: "BAD_ARGS", message: "agentId missing" } }));
          return;
        }
        this.peerAgents.set(ws, agentId);
        this.forward(method as WireMethodName, params, agentId)
          .then((result) => ws.send(JSON.stringify({ id, ok: true, result })))
          .catch((error) => ws.send(JSON.stringify({ id, ok: false, error })));
        return;
      }
      if (frame.kind !== "notification") return;
      const { notification, payload } = frame.value;
      if (notification === "activity.show") {
        const p = payload as { tabId?: unknown; action?: unknown; target?: unknown; task?: unknown; agentId?: unknown };
        if (typeof p?.tabId === "number" && typeof p.action === "string" && typeof p.agentId === "string") {
          const parsed = TaskSnapshotSchema.safeParse(p.task);
          this.showActivity(
            p.tabId,
            p.action,
            typeof p.target === "string" ? p.target : undefined,
            parsed.success ? parsed.data : undefined,
            p.agentId,
          );
        }
      } else if (notification === "task.end") {
        const parsed = TaskEndPayloadSchema.safeParse(payload);
        if (parsed.success) this.notify("task.end", parsed.data);
      } else if (notification === "session.end") {
        const parsed = SessionEndPayloadSchema.safeParse(payload);
        if (parsed.success) this.notify("session.end", parsed.data);
      }
    });
    ws.on("close", () => this.dropPeer(ws));
    ws.on("error", () => this.dropPeer(ws));
  }

  /**
   * A peer that vanished without `session.end` (crash, kill) would keep its
   * group forever. Release it unless the same agent re-attaches shortly:
   * peers reconnect within ~1s after a hub handover.
   */
  private dropPeer(ws: WebSocket): void {
    if (!this.peers.delete(ws)) return;
    this.log("peer MCP process detached");
    const agentId = this.peerAgents.get(ws);
    this.peerAgents.delete(ws);
    if (!agentId) return;
    const timer = setTimeout(() => {
      if (this.stopped || [...this.peerAgents.values()].includes(agentId)) return;
      this.notify("session.end", { agentId });
    }, PEER_GONE_GRACE_MS);
    timer.unref?.();
  }

  private sendState(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: "state", payload: this.statePayload() }));
  }

  private statePayload(): { connected: boolean; extension: ExtensionInfo | null } {
    return { connected: this.connected, extension: this.extension };
  }

  private broadcastState(): void {
    for (const peer of this.peers) this.sendState(peer);
  }

  /** Relay extension pushes to peer processes so their activity view stays current. */
  private broadcastToPeers(frame: { event: string; payload: unknown }): void {
    const raw = JSON.stringify(frame);
    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(raw);
    }
  }

  // -- peer mode ------------------------------------------------------------

  private controlUrl(): string {
    return `ws://127.0.0.1:${this.opts.port}${CONTROL_PATH}`;
  }

  private async attach(): Promise<void> {
    const deadline = Date.now() + 5000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connectControl();
        this.mode = "peer";
        this.log(`attached to hub on port ${this.opts.port}`);
        return;
      } catch (err) {
        if (err instanceof BadTokenError) throw err;
        lastError = err;
        await delay(250);
      }
    }
    throw new Error(
      `port ${this.opts.port} is held by a process that does not speak the Remora control protocol ` +
        `(${lastError instanceof Error ? lastError.message : String(lastError)}). ` +
        `Free the port or set REMORA_PORT to another value.`,
    );
  }

  private connectControl(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.controlUrl(), tokenProtocols(this.opts.token));
      let settled = false;

      // A foreign server may accept the TCP/WS connection on this port, so a
      // successful `open` proves nothing. The hub announces itself with a
      // `state` event; without it we must not claim to be attached.
      const timer = setTimeout(() => {
        fail(new Error("no Remora hub handshake on this port"));
      }, 1000);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.terminate();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.control = ws;
        this.wireControl(ws);
        resolve();
      };
      const onMessage = (data: unknown) => {
        let frame;
        try {
          frame = parseWireFrame(String(data));
        } catch {
          return;
        }
        if (frame.kind === "event" && frame.value.event === "state") {
          this.applyState(frame.value.payload);
          succeed();
        }
      };
      const onError = (err: Error) => fail(err);
      const onClose = (code: number) =>
        fail(
          code === WS_CLOSE.BAD_TOKEN
            ? new BadTokenError(
                `the Remora hub on port ${this.opts.port} uses a different token. ` +
                  `Give every MCP client the same REMORA_TOKEN (or remove it so all read the config file).`,
              )
            : new Error("control socket closed during handshake"),
        );

      ws.on("message", onMessage);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  private applyState(payload: unknown): void {
    const p = payload as
      | { connected?: unknown; extension?: ExtensionInfo | null }
      | undefined;
    this.peerState = { connected: p?.connected === true, extension: p?.extension ?? null };
  }

  private wireControl(ws: WebSocket): void {
    ws.on("message", (data) => {
      let frame;
      try {
        frame = parseWireFrame(String(data));
      } catch {
        return;
      }
      if (frame.kind === "response") {
        this.settle(frame.value.id, frame.value.ok, frame.value.result, frame.value.error);
        return;
      }
      if (frame.kind === "event" && frame.value.event === "state") {
        this.applyState(frame.value.payload);
        return;
      }
      if (frame.kind === "event" && frame.value.event === "activity") {
        const p = frame.value.payload as
          | { tabId?: unknown; action?: unknown; target?: unknown }
          | undefined;
        if (typeof p?.tabId === "number" && typeof p.action === "string") {
          markActive(p.tabId, p.action, typeof p.target === "string" ? p.target : undefined);
        }
      }
    });
    ws.on("close", () => {
      if (this.control !== ws) return;
      this.control = null;
      this.peerState = { connected: false, extension: null };
      this.failAllPending({ code: "NO_EXTENSION", message: "hub link dropped" });
      this.scheduleReattach();
    });
    ws.on("error", (err) => this.log(`control socket error: ${String(err)}`));
  }

  private scheduleReattach(): void {
    if (this.stopped || this.reattachTimer) return;
    this.reattachTimer = setTimeout(async () => {
      this.reattachTimer = null;
      if (this.stopped) return;
      try {
        await this.connectControl();
        this.log("reattached to hub as peer");
        return;
      } catch {
        /* primary is gone; try to take the port over */
      }
      try {
        await this.startServer();
        this.log("took over as primary hub");
      } catch {
        this.scheduleReattach();
      }
    }, 1000);
    this.reattachTimer.unref?.();
  }

  private onTabClosed(tabId: number): void {
    markClosed(tabId);
  }

  private failAllPending(err: WireError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request to the extension, as this session, and await its response. */
  request<T = unknown>(
    method: WireMethodName,
    params?: unknown,
    timeoutMs = WS_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return this.forward<T>(method, params, this.agentId, timeoutMs);
  }

  private forward<T = unknown>(
    method: WireMethodName,
    params: unknown,
    agentId: string,
    timeoutMs = WS_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const check = validateMethodParams(method, params ?? {});
    if (!check.ok) {
      return Promise.reject({ code: "BAD_ARGS", message: check.message } satisfies WireError);
    }
    if (this.mode === "peer") {
      return this.requestViaControl<T>(method, params, agentId, timeoutMs);
    }
    if (!this.connected || !this.socket) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Chrome extension is not connected. Open Chrome with Remora installed and paired.",
      } satisfies WireError);
    }
    return this.dispatch<T>(this.socket, method, params, agentId, timeoutMs);
  }

  private requestViaControl<T>(
    method: WireMethodName,
    params: unknown,
    agentId: string,
    timeoutMs: number,
  ): Promise<T> {
    const ws = this.control;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Remora hub link is down; reconnecting to the hub.",
      } satisfies WireError);
    }
    return this.dispatch<T>(ws, method, params, agentId, timeoutMs);
  }

  private dispatch<T>(
    ws: WebSocket,
    method: WireMethodName,
    params: unknown,
    agentId: string,
    timeoutMs: number,
  ): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", message: `extension did not answer ${method} in time` } satisfies WireError);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      ws.send(JSON.stringify({ id, method, params: params ?? {}, agentId }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject({ code: "INTERNAL", message: `send failed: ${String(err)}` } satisfies WireError);
      });
    });
  }

  /** Fire-and-forget notification to the extension (e.g. activity.show). */
  notify(notification: string, payload?: unknown): void {
    if (this.mode === "peer") {
      const ws = this.control;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ notification, payload: payload ?? {} }));
      }
      return;
    }
    if (!this.connected || !this.socket) return;
    try {
      this.socket.send(JSON.stringify({ notification, payload: payload ?? {} }));
    } catch (err) {
      this.log(`notify failed: ${String(err)}`);
    }
  }

  /** Tell the extension to render activity on a tab (pill + badge + title). */
  showActivity(tabId: number, action: string, target?: string, task?: TaskSnapshot, agentId = this.agentId): void {
    markActive(tabId, action, target);
    this.notify("activity.show", { tabId, agentId, action, target, task });
  }

  /** This session's own tool call: counts as a task step, then renders. */
  touch(tabId: number, action: string, target?: string): void {
    this.showActivity(tabId, action, target, this.tasks.touch(tabId));
  }

  /** Release the indicators on every tab the finished task touched. */
  private emitTaskEnd(ended: TaskEnded): void {
    for (const tabId of ended.tabIds) {
      markClosed(tabId);
      this.notify("task.end", {
        tabId,
        agentId: this.agentId,
        outcome: ended.outcome,
        label: ended.label,
        steps: ended.steps,
        durationMs: ended.durationMs,
      });
    }
  }
}
