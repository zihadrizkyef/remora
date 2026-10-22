import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  ExtensionHelloPayloadSchema,
  NavigatedPayloadSchema,
  TabClosedPayloadSchema,
  UploadProgressPayloadSchema,
  WS_HEARTBEAT_MS,
  WS_PATH,
  WS_REQUEST_TIMEOUT_MS,
  WireError,
  WireMethodName,
  parseWireFrame,
  validateMethodParams,
} from "@remora/protocol";
import { markActive, markClosed } from "./activity.js";

/**
 * WebSocket hub: the MCP server listens on 127.0.0.1 and the Chrome
 * extension connects as a client. Exactly one extension is served at a
 * time (the newest connection wins); requests time out and fail fast
 * with typed wire errors so tools never hang forever.
 */

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

export class RemoraHub {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private info: ExtensionInfo | null = null;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;

  constructor(private readonly opts: { port: number; token: string }) {
    this.log = (msg) => console.error(`[remora hub] ${msg}`);
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get extension(): ExtensionInfo | null {
    return this.info;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port, path: WS_PATH });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", () => resolve());
      this.wss!.once("error", (err) => reject(err));
    });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req.url ?? ""));
    this.heartbeat = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, WS_HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.log(`listening on 127.0.0.1:${this.opts.port}${WS_PATH}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject({ code: "INTERNAL", message: "hub shutting down" });
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.info = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  private handleConnection(ws: WebSocket, url: string): void {
    const token = new URL(url, "http://localhost").searchParams.get("token");
    if (token !== this.opts.token) {
      this.log("rejected connection with bad token");
      ws.close(4401, "bad token");
      return;
    }
    if (this.socket) {
      this.log("replacing previous extension connection");
      try {
        this.socket.close(4000, "replaced");
      } catch {
        /* ignore */
      }
      this.failAllPending({ code: "INTERNAL", message: "extension reconnected" });
    }
    this.socket = ws;
    this.log("extension connected, waiting for hello");
    ws.on("message", (data) => this.handleMessage(String(data)));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.info = null;
        this.log("extension disconnected");
        this.failAllPending({ code: "NO_EXTENSION", message: "extension disconnected" });
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
      const p = this.pending.get(frame.value.id);
      if (!p) return;
      this.pending.delete(frame.value.id);
      clearTimeout(p.timer);
      if (frame.value.ok) p.resolve(frame.value.result);
      else p.reject(frame.value.error ?? { code: "INTERNAL", message: "empty error" });
      return;
    }
    if (frame.kind === "event") {
      this.handleEvent(frame.value.event, frame.value.payload);
      return;
    }
    this.log(`ignoring unexpected frame kind: ${frame.kind}`);
  }

  private handleEvent(event: string, payload: unknown): void {
    switch (event) {
      case "hello": {
        const parsed = ExtensionHelloPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          this.log("bad hello payload, closing");
          this.socket?.close(4002, "bad hello");
          return;
        }
        this.info = { ...parsed.data, connectedAt: Date.now() };
        this.log(`hello from extension v${parsed.data.version} (${parsed.data.tabCount} tabs)`);
        break;
      }
      case "tab_closed": {
        const parsed = TabClosedPayloadSchema.safeParse(payload);
        if (parsed.success) markClosed(parsed.data.tabId);
        break;
      }
      case "navigated": {
        const parsed = NavigatedPayloadSchema.safeParse(payload);
        if (parsed.success) {
          markActive(parsed.data.tabId, "navigated", parsed.data.title || parsed.data.url);
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

  private failAllPending(err: WireError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request to the extension and await its response. */
  request<T = unknown>(
    method: WireMethodName,
    params?: unknown,
    timeoutMs = WS_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const check = validateMethodParams(method, params ?? {});
    if (!check.ok) {
      return Promise.reject({ code: "BAD_ARGS", message: check.message } satisfies WireError);
    }
    if (!this.connected || !this.socket) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Chrome extension is not connected. Open Chrome with Remora installed and paired.",
      } satisfies WireError);
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", message: `extension did not answer ${method} in time` } satisfies WireError);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify({ id, method, params: params ?? {} }), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject({ code: "INTERNAL", message: `send failed: ${String(err)}` } satisfies WireError);
        }
      });
    });
  }

  /** Fire-and-forget notification to the extension (e.g. activity.show). */
  notify(notification: string, payload?: unknown): void {
    if (!this.connected || !this.socket) return;
    try {
      this.socket.send(JSON.stringify({ notification, payload: payload ?? {} }));
    } catch (err) {
      this.log(`notify failed: ${String(err)}`);
    }
  }

  /** Tell the extension to render activity on a tab (pill + badge + title). */
  showActivity(tabId: number, action: string, target?: string): void {
    markActive(tabId, action, target);
    this.notify("activity.show", { tabId, action, target });
  }
}
