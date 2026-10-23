import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  ExtensionHelloPayloadSchema,
  NavigatedPayloadSchema,
  TabClosedPayloadSchema,
  TaskEndPayloadSchema,
  TaskSnapshotSchema,
  UploadProgressPayloadSchema,
  WS_HEARTBEAT_MS,
  WS_PATH,
  WS_REQUEST_TIMEOUT_MS,
  WS_SUBPROTOCOL,
  WireError,
  WireMethodName,
  parseWireFrame,
  tokenFromProtocols,
  tokenProtocols,
  validateMethodParams,
} from "@remora/protocol";
import { markActive, markClosed } from "./activity.js";
import { TaskTracker, type TaskEnded, type TaskSnapshot } from "./tasks.js";
import { ClaimStore, ClaimSnapshot, TabClaim } from "./claims.js";

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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RemoraHub {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private info: ExtensionInfo | null = null;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;

  /** Stable id for this MCP process, so claims can name their owner. */
  readonly agentId: string;
  /** Short human label shown to other agents on claimed tabs. */
  readonly ownerLabel: string;
  private claims = new ClaimStore();
  readonly tasks = new TaskTracker((ended) => this.emitTaskEnd(ended));

  /**
   * This session's working tab: set by tab_create/tab_duplicate/tab_claim
   * (and any explicit-tabId mutation). Calls without tabId resolve here
   * first instead of the window-active tab, so concurrent sessions stop
   * stealing each other's focus and spawning tabs.
   */
  private workingTab: number | undefined;

  private mode: HubMode = "server";
  private control: WebSocket | null = null;
  private peers = new Set<WebSocket>();
  private peerState: { connected: boolean; extension: ExtensionInfo | null } = {
    connected: false,
    extension: null,
  };
  private stopped = false;
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

  // -- tab claims -------------------------------------------------------------

  /** Naming shown to other agents, e.g. `ZCode abc123` or `agent 1a2b3c`. */
  get claimOwnerLabel(): string {
    return this.ownerLabel;
  }

  get claimStore(): ClaimStore {
    return this.claims;
  }

  /** Active claims (primary: authoritative; peer: last broadcast snapshot). */
  listClaims(): TabClaim[] {
    return this.claims.list();
  }

  /** This session's working tab (may be undefined before first use). */
  myWorkingTab(): number | undefined {
    return this.workingTab;
  }

  setWorkingTab(tabId: number): void {
    this.workingTab = tabId;
  }

  /** Forget the working tab, but only if it is the given one. */
  clearWorkingTab(tabId: number): void {
    this.forgetWorkingTab(tabId);
  }

  private forgetWorkingTab(tabId: number): void {
    if (this.workingTab === tabId) this.workingTab = undefined;
  }

  /** Drop claims for tabs that no longer exist; broadcast the trim. */
  pruneClaims(knownTabIds: Set<number> | number[]): number[] {
    if (this.mode !== "server") return [];
    const dropped = this.claims.prune(knownTabIds);
    if (dropped.length > 0) this.broadcastClaims();
    return dropped;
  }

  private claimedError(claim: TabClaim): WireError {
    const who = claim.ownerLabel ? ` by ${claim.ownerLabel}` : "";
    const what = claim.note ? ` (${claim.note})` : "";
    return {
      code: "TAB_CLAIMED",
      message: `Tab ${claim.tabId} is claimed${who}${what}. Pick another tab (call tabs_list), or ask the user.`,
    };
  }

  /**
   * Guard a mutating request. Resolves the effective tab (explicit tabId, or
   * the active tab via the extension) and rejects with TAB_CLAIMED when
   * another agent owns it. Returns the resolved tabId, or the raw guard
   * result when the resolution itself went wrong.
   */
  async guardTab(tabId?: number): Promise<number | undefined> {
    // This session already has a working tab and the call is implicit: stay
    // there. (Explicit tabId still goes through the claim check below.)
    if (tabId === undefined && this.workingTab !== undefined) {
      const verdict = this.mode === "peer"
        ? await this.checkViaPrimary(this.workingTab)
        : this.claims.check(this.workingTab, this.agentId);
      if (!verdict.allowed) throw this.claimedError(verdict.claim);
      return this.workingTab;
    }
    // Peers ask the primary so the verdict is always authoritative — no
    // race with the claim broadcast.
    if (this.mode === "peer") return this.guardViaPrimary(tabId);
    if (tabId !== undefined) {
      const verdict = this.claims.check(tabId, this.agentId);
      if (!verdict.allowed) throw this.claimedError(verdict.claim);
      return tabId;
    }
    // No explicit tab: mutation would land on the active tab. Block only if
    // the active tab is claimed by someone else; leave the extension call to
    // fail naturally when the tab cannot be determined.
    try {
      const tabs = await this.request<Array<{ id?: number; active?: boolean }>>("tabs.list", {});
      const active = tabs.find((t) => t.active);
      if (active && typeof active.id === "number") {
        const verdict = this.claims.check(active.id, this.agentId);
        if (!verdict.allowed) throw this.claimedError(verdict.claim);
        return active.id;
      }
    } catch (err) {
      if ((err as WireError | undefined)?.code === "TAB_CLAIMED") throw err;
      // Extension unreachable etc. — let the real call surface the error.
    }
    return undefined;
  }

  /**
   * Peer-side guard: ask the primary for an authoritative verdict (also
   * resolves the implicit active tab there). Falls back to the cached
   * snapshot when the hub link is down — the real extension call then fails
   * with the link error as before.
   */
  private async guardViaPrimary(tabId?: number): Promise<number | undefined> {
    try {
      const verdict = await this.controlCall<{ allowed: boolean; claim?: TabClaim; activeId?: number }>(
        "guard",
        tabId !== undefined ? { tabId } : {},
      );
      if (!verdict.allowed && verdict.claim) throw this.claimedError(verdict.claim);
      return tabId ?? verdict.activeId;
    } catch (err) {
      if ((err as WireError | undefined)?.code === "TAB_CLAIMED") throw err;
      return this.guardFromCache(tabId);
    }
  }

  /**
   * Check one explicit tab against the primary (peer fast-path for the
   * working-tab shortcut). Falls back to the cached snapshot when the hub
   * link is down; rethrows TAB_CLAIMED either way.
   */
  private async checkViaPrimary(
    tabId: number,
  ): Promise<{ allowed: true } | { allowed: false; claim: TabClaim }> {
    try {
      const verdict = await this.controlCall<{ allowed: boolean; claim?: TabClaim }>(
        "guard",
        { tabId },
      );
      if (!verdict.allowed && verdict.claim) return { allowed: false, claim: verdict.claim };
      return { allowed: true };
    } catch (err) {
      if ((err as { code?: string; claim?: TabClaim }).code === "TAB_CLAIMED") {
        const claim = (err as { claim?: TabClaim }).claim ?? this.claims.get(tabId);
        if (claim) return { allowed: false, claim };
      }
      return this.claims.check(tabId, this.agentId);
    }
  }

  private async guardFromCache(tabId?: number): Promise<number | undefined> {
    if (tabId !== undefined) {
      const verdict = this.claims.check(tabId, this.agentId);
      if (!verdict.allowed) throw this.claimedError(verdict.claim);
      return tabId;
    }
    try {
      const tabs = await this.request<Array<{ id?: number; active?: boolean }>>("tabs.list", {});
      const active = tabs.find((t) => t.active);
      if (active && typeof active.id === "number") {
        const verdict = this.claims.check(active.id, this.agentId);
        if (!verdict.allowed) throw this.claimedError(verdict.claim);
        return active.id;
      }
    } catch (err) {
      if ((err as WireError | undefined)?.code === "TAB_CLAIMED") throw err;
    }
    return undefined;
  }

  async start(): Promise<void> {
    this.stopped = false;
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
    // Before teardown, so the notification can still reach the extension.
    this.tasks.end("aborted");
    this.stopped = true;
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    // A dying session must not hold tabs hostage: drop its own claims and
    // tell the other side (primary broadcasts, peer asks the primary).
    if (this.mode === "server") {
      if (this.claims.clearMine(this.agentId).length > 0) this.broadcastClaims();
    } else {
      for (const c of this.claims.list()) {
        if (c.agentId === this.agentId && this.control?.readyState === WebSocket.OPEN) {
          this.control.send(
            JSON.stringify({
              id: randomUUID(),
              method: "claims.release",
              params: { tabId: c.tabId, agentId: this.agentId, ownerLabel: this.ownerLabel },
            }),
          );
        }
      }
    }
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
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ event: "heartbeat" }));
      }
    }, WS_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private handleConnection(ws: WebSocket, url: string, token: string | null): void {
    const parsed = new URL(url, "http://localhost");
    if (token === null || !sameToken(token, this.opts.token)) {
      this.log("rejected connection with bad token");
      ws.close(4401, "bad token");
      return;
    }
    if (parsed.pathname === CONTROL_PATH) {
      this.handlePeer(ws);
      return;
    }
    if (parsed.pathname !== WS_PATH) {
      this.log(`rejected connection on unknown path ${parsed.pathname}`);
      ws.close(4404, "unknown path");
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
          this.socket?.close(4002, "bad hello");
          return;
        }
        this.info = { ...parsed.data, connectedAt: Date.now() };
        this.log(`hello from extension v${parsed.data.version} (${parsed.data.tabCount} tabs)`);
        this.broadcastState();
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
        const { id, method, params } = frame.value;
        if (method === "claims.claim" || method === "claims.release" || method === "claims.guard") {
          void this.handleClaimOp(ws, id, method, params);
          return;
        }
        this.request(method as WireMethodName, params)
          .then((result) => ws.send(JSON.stringify({ id, ok: true, result })))
          .catch((error) => ws.send(JSON.stringify({ id, ok: false, error })));
        return;
      }
      if (frame.kind === "notification" && frame.value.notification === "activity.show") {
        const p = frame.value.payload as { tabId?: unknown; action?: unknown; target?: unknown; task?: unknown };
        if (typeof p?.tabId === "number" && typeof p.action === "string") {
          const parsed = TaskSnapshotSchema.safeParse(p.task);
          this.showActivity(
            p.tabId,
            p.action,
            typeof p.target === "string" ? p.target : undefined,
            parsed.success ? parsed.data : undefined,
          );
        }
      }
      if (frame.kind === "notification" && frame.value.notification === "task.end") {
        const parsed = TaskEndPayloadSchema.safeParse(frame.value.payload);
        if (parsed.success) this.notify("task.end", parsed.data);
      }
    });
    ws.on("close", () => {
      this.peers.delete(ws);
      this.log("peer MCP process detached");
    });
    ws.on("error", () => this.peers.delete(ws));
  }

  private sendState(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: "state", payload: this.statePayload() }));
  }

  private statePayload(): { connected: boolean; extension: ExtensionInfo | null; claims: ClaimSnapshot[] } {
    return { connected: this.connected, extension: this.extension, claims: this.claims.snapshot() };
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
      const onClose = () => fail(new Error("control socket closed during handshake"));

      ws.on("message", onMessage);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  private applyState(payload: unknown): void {
    const p = payload as
      | { connected?: unknown; extension?: ExtensionInfo | null; claims?: ClaimSnapshot[] }
      | undefined;
    this.peerState = { connected: p?.connected === true, extension: p?.extension ?? null };
    if (Array.isArray(p?.claims)) this.claims.applySnapshot(p.claims);
  }

  /**
   * Primary-side claim op from a peer. The peer identifies itself by its
   * agentId + ownerLabel; the claim is recorded under that identity so the
   * TAB_CLAIMED message names the right owner.
   */
  private async handleClaimOp(
    ws: WebSocket,
    id: string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const p = params as { tabId?: unknown; note?: unknown; agentId?: unknown; ownerLabel?: unknown };
    const tabId = p?.tabId;
    const peerId = typeof p?.agentId === "string" && p.agentId ? p.agentId : "peer";
    const peerLabel = typeof p?.ownerLabel === "string" && p.ownerLabel ? p.ownerLabel : peerId;
    const reply = (ok: boolean, result?: unknown, error?: WireError) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok, result, error }));
    };
    if (method === "claims.guard") {
      // No tabId: resolve the active tab via the extension first.
      let target = typeof tabId === "number" ? tabId : undefined;
      if (target === undefined) {
        try {
          const tabs = await this.request<Array<{ id?: number; active?: boolean }>>("tabs.list", {});
          target = tabs.find((t) => t.active)?.id;
        } catch {
          reply(true, { allowed: true });
          return;
        }
        if (target === undefined) {
          reply(true, { allowed: true });
          return;
        }
      }
      const verdict = this.claims.check(target, peerId);
      if (!verdict.allowed) {
        reply(false, undefined, this.claimedError(verdict.claim));
        return;
      }
      reply(true, { allowed: true, activeId: target });
      return;
    }
    if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
      reply(false, undefined, { code: "BAD_ARGS", message: "tabId must be an integer" });
      return;
    }
    try {
      if (method === "claims.claim") {
        const note = typeof p?.note === "string" ? p.note : undefined;
        const claim = this.claims.claim(tabId, peerId, peerLabel, note);
        this.broadcastClaims();
        reply(true, claim);
      } else {
        const done = this.claims.release(tabId, peerId);
        if (done) this.broadcastClaims();
        reply(true, done);
      }
    } catch {
      const existing = this.claims.get(tabId);
      reply(false, undefined, existing ? this.claimedError(existing) : {
        code: "INTERNAL",
        message: "could not update claim",
      });
    }
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
      if (frame.kind === "event" && frame.value.event === "claims") {
        const entries = frame.value.payload;
        if (Array.isArray(entries)) this.claims.applySnapshot(entries as ClaimSnapshot[]);
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

  // -- claim operations (primary authoritative, peer via control) -------------

  /**
   * Claim a tab for this session. On the primary this writes the store
   * directly and broadcasts; on a peer it asks the primary over the control
   * channel (which enforces and broadcasts the same way).
   */
  async claimTab(tabId: number, note?: string): Promise<TabClaim> {
    if (this.mode === "peer") {
      return this.controlCall<TabClaim>("claim", { tabId, note });
    }
    try {
      const claim = this.claims.claim(tabId, this.agentId, this.ownerLabel, note);
      this.broadcastClaims();
      return claim;
    } catch {
      const existing = this.claims.get(tabId);
      if (existing) throw this.claimedError(existing);
      throw { code: "INTERNAL", message: "could not claim tab" } satisfies WireError;
    }
  }

  async releaseTab(tabId: number): Promise<boolean> {
    if (this.mode === "peer") {
      return this.controlCall<boolean>("release", { tabId });
    }
    try {
      const done = this.claims.release(tabId, this.agentId);
      if (done) this.broadcastClaims();
      return done;
    } catch {
      const existing = this.claims.get(tabId);
      if (existing) throw this.claimedError(existing);
      throw { code: "INTERNAL", message: "could not release tab" } satisfies WireError;
    }
  }

  private controlCall<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const ws = this.control;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Remora hub link is down; reconnecting to the hub.",
      } satisfies WireError);
    }
    const id = randomUUID();
    const body = { ...payload, agentId: this.agentId, ownerLabel: this.ownerLabel };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", message: `hub did not answer ${op} in time` } satisfies WireError);
      }, 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      ws.send(JSON.stringify({ id, method: `claims.${op}`, params: body }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject({ code: "INTERNAL", message: `send failed: ${String(err)}` } satisfies WireError);
      });
    });
  }

  private broadcastClaims(): void {
    const snapshot = this.claims.snapshot();
    this.broadcastToPeers({ event: "claims", payload: snapshot });
  }

  private onTabClosed(tabId: number): void {
    markClosed(tabId);
    this.forgetWorkingTab(tabId);
    if (this.mode === "server") {
      if (this.claims.get(tabId)) {
        this.claims.remove(tabId);
        this.broadcastClaims();
      }
    } else {
      // Peers drop their cached entry; primary broadcasts authoritatively.
      this.claims.remove(tabId);
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
    if (this.mode === "peer") {
      return this.requestViaControl<T>(method, params, timeoutMs);
    }
    if (!this.connected || !this.socket) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Chrome extension is not connected. Open Chrome with Remora installed and paired.",
      } satisfies WireError);
    }
    return this.dispatch<T>(this.socket, method, params, timeoutMs);
  }

  private requestViaControl<T>(
    method: WireMethodName,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const ws = this.control;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject({
        code: "NO_EXTENSION",
        message: "Remora hub link is down; reconnecting to the hub.",
      } satisfies WireError);
    }
    return this.dispatch<T>(ws, method, params, timeoutMs);
  }

  private dispatch<T>(
    ws: WebSocket,
    method: WireMethodName,
    params: unknown,
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
      ws.send(JSON.stringify({ id, method, params: params ?? {} }), (err) => {
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
  showActivity(tabId: number, action: string, target?: string, task?: TaskSnapshot): void {
    markActive(tabId, action, target);
    this.notify("activity.show", { tabId, action, target, task });
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
        outcome: ended.outcome,
        label: ended.label,
        steps: ended.steps,
        durationMs: ended.durationMs,
      });
    }
  }
}
