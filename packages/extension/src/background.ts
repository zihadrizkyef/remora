/**
 * Remora background service worker (MV3, ESM).
 *
 * - Owns the WebSocket client to the MCP hub (ws://127.0.0.1:PORT/remora).
 * - Routes wire methods: background-implemented (tabs, navigation capture,
 *   cookies, downloads, screenshots) vs content-routed (per-tab DOM work).
 * - Tracks per-tab state for the activity UI (badge, pending notifications).
 * - Enforces tab isolation: every request names its agent session, and only
 *   tabs inside that session's Remora tab group may be touched.
 */

import {
  DEFAULT_WS_PORT,
  NO_GROUP_TAB_MESSAGE,
  OUT_OF_GROUP_MESSAGE,
  SessionEndPayloadSchema,
  ShowActivityPayloadSchema as ActivityShowSchema,
  TAB_GROUP_NONE,
  TaskEndPayloadSchema,
  WS_CLOSE,
  WS_PATH,
  WS_PING_MS,
  WS_STALE_MS,
  WireErrorCode,
  checkTab,
  clampIndexToGroup,
  groupForNewTab,
  hostOf,
  isDownloadInScope,
  isTabAllowed,
  isUrlInScope,
  ownerOf,
  resolveImplicitTab,
  tokenFingerprint,
  tokenProtocols,
  parseWireFrame,
  validateMethodParams,
  visibleTabs,
} from "@remora/protocol";
import type { OwnedGroup, TaskSnapshotPayload } from "@remora/protocol";
import {
  createGroupedTab,
  forgetGroup,
  groupFor,
  loadGroups,
  rememberHost,
  releaseSession,
  setWorkingTab,
  showResult,
  showRunning,
  toRef,
  updateGroups,
} from "./groups.js";
import { isSiteBlocked, isWireError, loadSettings, wireError } from "./shared.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface NetEntry {
  id: string;
  method: string;
  url: string;
  statusCode?: number;
  timeStamp: number;
  durationMs?: number;
  type?: string;
}

let ws: WebSocket | null = null;
let wsReady = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let settingsToken = "";
let settingsTokenId = "";
let settingsPort = DEFAULT_WS_PORT;
let jsEvalEnabled = false;
let netCaptureEnabled = false;
let blockedSites: string[] = [];

const capturingTabs = new Map<number, { pattern?: string; entries: NetEntry[] }>();
const completedAt = new Map<string, number>();
/** Tabs an agent has addressed, so their close/navigation is reported only to the hub. */
const agentTabs = new Map<number, string>();

// Content-script readiness + upload staging live in each tab's content
// script; background only forwards messages and reports errors.

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function refreshSettings(): Promise<void> {
  const s = await loadSettings();
  settingsToken = s.token;
  settingsTokenId = s.token ? await tokenFingerprint(s.token) : "";
  settingsPort = s.port;
  jsEvalEnabled = s.jsEvalEnabled;
  netCaptureEnabled = s.netCaptureEnabled;
  blockedSites = s.blockedSites;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  void (async () => {
    const tokenChanged = changes.token && changes.token.newValue !== settingsToken;
    const portChanged = changes.port && Number(changes.port.newValue) !== settingsPort;
    await refreshSettings();
    if (tokenChanged || portChanged) {
      reconnectDelayMs = 1000;
      connect();
    }
  })();
});

// Every worker start runs the module once; these listeners only exist so
// Chrome wakes the worker on browser start / install.
const booted = boot();
chrome.runtime.onStartup.addListener(() => void booted);
chrome.runtime.onInstalled.addListener(() => void booted);

async function boot(): Promise<void> {
  await refreshSettings();
  registerNetListeners();
  // Older builds kept global dynamic block rules; blocking is now per group.
  await clearLegacyBlockRules().catch(() => undefined);
  await loadGroups().catch(() => undefined);
  await rebuildBlockRules().catch(() => undefined);
  connect();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturingTabs.delete(tabId);
  const agentId = agentTabs.get(tabId);
  agentTabs.delete(tabId);
  if (agentId) sendEvent("tab_closed", { tabId, agentId });
  recentActivity.delete(tabId);
  clearTabBadge(tabId).catch(() => undefined);
  scheduleBlockRebuild();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  void (async () => {
    const groups = await loadGroups();
    const owner = ownerOf(groups, tab.groupId ?? TAB_GROUP_NONE);
    if (info.groupId !== undefined) {
      // The user dragged the tab in or out of a group: access follows at once.
      scheduleBlockRebuild();
      const had = agentTabs.get(tabId);
      if (had && had !== owner) revokeTab(tabId);
      if (owner) await rememberHost(tab.groupId!, tab.url);
    }
    if (!owner) return;
    if (info.url) await rememberHost(tab.groupId!, info.url);
    if (info.status === "complete" && tab.url && tab.title) {
      agentTabs.set(tabId, owner);
      sendEvent("navigated", { tabId, agentId: owner, url: tab.url, title: tab.title });
    }
  })();
});

// Links opened from a group tab (target=_blank, window.open) join that group.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  void (async () => {
    const opener = await chrome.tabs.get(tab.openerTabId!).catch(() => undefined);
    const groupId = groupForNewTab(
      { groupId: tab.groupId ?? TAB_GROUP_NONE, windowId: tab.windowId, openerTabId: tab.openerTabId },
      opener ? toRef(opener) : undefined,
      await loadGroups(),
    );
    if (groupId !== undefined) await chrome.tabs.group({ groupId, tabIds: tab.id! }).catch(() => undefined);
  })();
});

// Closing or ungrouping the whole group ends the session's access to it.
chrome.tabGroups.onRemoved.addListener((group) => {
  void forgetGroup(group.id).then(() => scheduleBlockRebuild());
});

/** Access to this tab is gone: drop its markers and per-tab agent state. */
function revokeTab(tabId: number): void {
  agentTabs.delete(tabId);
  capturingTabs.delete(tabId);
  recentActivity.delete(tabId);
  clearTabBadge(tabId).catch(() => undefined);
  void chrome.tabs.sendMessage(tabId, { type: "remora:release" }).catch(() => undefined);
}

// Popup bridge: status queries, manual reconnect, audit-log reads.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const type = (msg as { type?: string }).type;
  if (type === "remora:status") {
    void booted.then(() => sendResponse(connStatus()));
    return true;
  }
  if (type === "remora:reconnect") {
    void (async () => {
      await booted;
      await refreshSettings();
      reconnectDelayMs = 1000;
      connect();
      await waitSettled(6000);
      sendResponse(connStatus());
    })();
    return true;
  }
  if (type === "remora:ready") {
    // A fresh page in a tab the agent touched <8s ago (e.g. right after
    // `navigate`) gets the last activity back so the pill survives reloads.
    const tabId = _sender.tab?.id;
    const recent = tabId !== undefined ? recentActivity.get(tabId) : undefined;
    if (recent && (recent.task || Date.now() - recent.ts < ACTIVITY_IDLE_MS)) {
      sendResponse({ active: true, action: recent.action, target: recent.target, task: recent.task });
    } else {
      sendResponse({ active: false });
    }
    return false;
  }
  return false;
});

// MV3 suspends the worker, so the socket can drop while idle; an alarms tick
// wakes the worker and reconnects without relying on it staying alive.
if (chrome.alarms) {
  chrome.alarms.create("remora-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "remora-keepalive") return;
    void booted.then(() => {
      if (!ws && !reconnectTimer) connect();
    });
  });
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

type ConnPhase = "unpaired" | "connecting" | "connected" | "retrying";
type ConnErrorCode = "SERVER_DOWN" | "BAD_TOKEN" | "REPLACED" | "PROTOCOL" | "STALE" | "DROPPED";

interface ConnError {
  code: ConnErrorCode;
  message: string;
  at: number;
}

let phase: ConnPhase = "unpaired";
let lastError: ConnError | null = null;
let nextRetryAt: number | null = null;
let attempt = 0;
let connectedAt: number | null = null;
let lastLatencyMs: number | undefined;
let hubInfo: { server?: string; tokenId?: string } = {};
let pingTimer: ReturnType<typeof setInterval> | null = null;
let readyFallback: ReturnType<typeof setTimeout> | null = null;
let wsTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let staleClose = false;
const settleWaiters = new Set<() => void>();

const MAX_BACKOFF_MS = 10_000;
const REPLACED_RETRY_MS = 30_000;
// Hubs older than the `welcome` frame never announce themselves; a link that
// survives this long passed the token check.
const READY_FALLBACK_MS = 1500;

function connStatus() {
  return {
    phase,
    connected: phase === "connected",
    port: settingsPort,
    attempt,
    lastError,
    nextRetryAt,
    connectedAt,
    latencyMs: phase === "connected" ? lastLatencyMs : undefined,
    tokenId: settingsTokenId || null,
    hubTokenId: hubInfo.tokenId ?? null,
    hubVersion: hubInfo.server ?? null,
  };
}

/** Resolve once the current attempt connects or fails (or after `ms`). */
function waitSettled(ms: number): Promise<void> {
  if (phase !== "connecting") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      settleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    settleWaiters.add(done);
  });
}

function settled(): void {
  for (const done of [...settleWaiters]) done();
}

function wsUrl(): string {
  return `ws://127.0.0.1:${settingsPort}${WS_PATH}`;
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  nextRetryAt = null;
  if (ws) {
    // Detach first: the old socket's close event fires asynchronously, and an
    // unguarded handler would null out the socket we are about to create.
    detach(ws);
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    ws = null;
  }
  stopLinkTimers();
  wsReady = false;
  connectedAt = null;
  if (!settingsToken) {
    phase = "unpaired";
    settled();
    return;
  }

  phase = "connecting";
  attempt++;
  let opened = false;
  staleClose = false;
  const socket = new WebSocket(wsUrl(), tokenProtocols(settingsToken));
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    opened = true;
    resetWsTimeout();
    readyFallback = setTimeout(() => {
      if (ws === socket && phase === "connecting") markReady();
    }, READY_FALLBACK_MS);
    void chrome.tabs.query({}).then((tabs) => {
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          event: "hello",
          payload: { version: chrome.runtime.getManifest().version, protocol: 1, tabCount: tabs.length },
        }),
      );
    });
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    resetWsTimeout();
    const raw = String(ev.data);
    if (handleLinkFrame(raw)) return;
    if (phase === "connecting") markReady();
    void handleFrame(raw);
  };
  socket.onclose = (ev) => {
    if (ws !== socket) return;
    ws = null;
    wsReady = false;
    connectedAt = null;
    stopLinkTimers();
    lastError = classifyClose(ev.code, ev.reason, opened);
    scheduleReconnect(lastError.code);
    settled();
  };
  socket.onerror = () => {
    // Chrome gives no detail here; onclose follows with the code we report.
  };
}

/** Link-level frames (`welcome`, `pong`) never reach the request router. */
function handleLinkFrame(raw: string): boolean {
  let frame: { event?: unknown; payload?: Record<string, unknown> };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return false;
  }
  if (frame.event === "welcome") {
    hubInfo = {
      server: typeof frame.payload?.server === "string" ? frame.payload.server : undefined,
      tokenId: typeof frame.payload?.tokenId === "string" ? frame.payload.tokenId : undefined,
    };
    markReady();
    return true;
  }
  if (frame.event === "pong") {
    const t = Number(frame.payload?.t);
    if (Number.isFinite(t)) lastLatencyMs = Math.max(0, Date.now() - t);
    return true;
  }
  return false;
}

function markReady(): void {
  if (phase === "connected") return;
  if (readyFallback) {
    clearTimeout(readyFallback);
    readyFallback = null;
  }
  phase = "connected";
  wsReady = true;
  connectedAt = Date.now();
  lastError = null;
  attempt = 0;
  reconnectDelayMs = 1000;
  sendPing();
  pingTimer = setInterval(sendPing, WS_PING_MS);
  settled();
}

function sendPing(): void {
  send({ event: "ping", payload: { t: Date.now() } });
}

function classifyClose(code: number, reason: string, opened: boolean): ConnError {
  const at = Date.now();
  if (staleClose) {
    return { code: "STALE", at, message: `Server tidak merespons selama ${WS_STALE_MS / 1000} detik.` };
  }
  switch (code) {
    case WS_CLOSE.BAD_TOKEN:
      return {
        code: "BAD_TOKEN",
        at,
        message:
          "Token ditolak server: token di extension beda dengan token MCP server. " +
          "Tempel token server di kolom di bawah, atau salin config ke MCP client lalu restart client.",
      };
    case WS_CLOSE.REPLACED:
      return {
        code: "REPLACED",
        at,
        message: "Diambil alih koneksi Remora lain (profil Chrome lain?). Dicoba lagi dalam 30 detik.",
      };
    case WS_CLOSE.STALE:
      return { code: "STALE", at, message: "Server memutus koneksi karena extension tidak merespons." };
    case WS_CLOSE.BAD_HELLO:
    case WS_CLOSE.UNKNOWN_PATH:
      return {
        code: "PROTOCOL",
        at,
        message: `Versi server dan extension tidak cocok (${reason || code}). Build ulang lalu restart MCP client.`,
      };
  }
  if (!opened) {
    return {
      code: "SERVER_DOWN",
      at,
      message:
        `Server MCP tidak berjalan di 127.0.0.1:${settingsPort}. ` +
        "Buka MCP client (Claude / ZCode) yang memuat Remora.",
    };
  }
  return { code: "DROPPED", at, message: `Koneksi terputus (kode ${code}${reason ? `: ${reason}` : ""}).` };
}

function stopLinkTimers(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (readyFallback) clearTimeout(readyFallback);
  readyFallback = null;
  clearWsTimeout();
}

/** Drop handlers so a superseded socket cannot mutate current state. */
function detach(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

function resetWsTimeout(): void {
  if (wsTimeoutTimer) clearTimeout(wsTimeoutTimer);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  wsTimeoutTimer = setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      staleClose = true;
      ws.close();
    }
  }, WS_STALE_MS);
}

function clearWsTimeout(): void {
  if (wsTimeoutTimer) {
    clearTimeout(wsTimeoutTimer);
    wsTimeoutTimer = null;
  }
}

function scheduleReconnect(code: ConnErrorCode): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  let waitMs: number;
  if (code === "REPLACED") {
    // Two extension instances would otherwise evict each other forever.
    waitMs = REPLACED_RETRY_MS;
  } else {
    waitMs = reconnectDelayMs + Math.floor(Math.random() * 300);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_BACKOFF_MS);
  }
  phase = "retrying";
  nextRetryAt = Date.now() + waitMs;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, waitMs);
}

function send(obj: unknown): void {
  if (ws && wsReady && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function supportsContentScript(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function sendEvent(event: string, payload?: unknown): void {
  send({ event, payload: payload ?? {} });
}

async function handleFrame(raw: string): Promise<void> {
  let frame;
  try {
    frame = parseWireFrame(raw);
  } catch {
    return;
  }
  if (frame.kind === "request") {
    const { id, method, params, agentId } = frame.value;
    if (!agentId) {
      send({ id, ok: false, error: { code: "BAD_ARGS", message: "request without agentId; update the Remora MCP server" } });
      return;
    }
    const check = validateMethodParams(method, params ?? {});
    if (!check.ok) {
      send({ id, ok: false, error: { code: "BAD_ARGS", message: check.message } });
      return;
    }
    try {
      const result = await dispatch(method, (params ?? {}) as Record<string, unknown>, agentId);
      send({ id, ok: true, result: result ?? {} });
    } catch (err) {
      if (isWireError(err)) {
        send({ id, ok: false, error: { code: err.code, message: err.message } });
      } else {
        send({
          id,
          ok: false,
          error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    return;
  }
  if (frame.kind === "notification") {
    handleNotification(frame.value.notification, frame.value.payload);
  }
}

function handleNotification(notification: string, payload: unknown): void {
  if (notification === "activity.show") {
    const parsed = ActivityShowSchema.safeParse(payload);
    if (!parsed.success) return;
    const p = parsed.data;
    recentActivity.set(p.tabId, { action: p.action, target: p.target, ts: Date.now(), task: p.task });
    void setTabBadge(p.tabId, p.action, p.target, !!p.task);
    if (p.task && p.task.step <= 1) {
      void appendActivityLog(p.tabId, "task start", p.task.label);
    }
    void appendActivityLog(p.tabId, p.action ?? "working", p.target);
    void chrome.tabs
      .sendMessage(p.tabId, { type: "remora:activity", action: p.action, target: p.target, task: p.task })
      .catch(() => undefined);
    if (p.agentId && p.task) {
      const task = p.task;
      void groupFor(p.agentId).then((g) => g && showRunning(g.groupId, task.label, task.step));
    }
    return;
  }
  if (notification === "task.end") {
    const parsed = TaskEndPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const p = parsed.data;
    recentActivity.delete(p.tabId);
    void showResultBadge(p.tabId, p.outcome);
    void appendActivityLog(p.tabId, `task ${p.outcome}`, `${p.steps} langkah`);
    if (p.agentId && p.outcome !== "aborted") {
      void groupFor(p.agentId).then((g) => g && showResult(g.groupId, p.outcome, p.label));
    }
    void chrome.tabs
      .sendMessage(p.tabId, {
        type: "remora:task_end",
        outcome: p.outcome,
        label: p.label,
        steps: p.steps,
        durationMs: p.durationMs,
      })
      .catch(() => undefined);
    return;
  }
  if (notification === "session.end") {
    const parsed = SessionEndPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    void releaseSession(parsed.data.agentId).then((tabIds) => {
      for (const tabId of tabIds) revokeTab(tabId);
      scheduleBlockRebuild();
    });
  }
}

async function appendActivityLog(tabId: number, action: string, target?: string): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const host = tab?.url ? new URL(tab.url).host : `tab#${tabId}`;
    const stored = await chrome.storage.local.get({ activityLog: [] });
    const log = stored.activityLog as Array<{ ts: number; action: string; detail: string }>;
    log.push({
      ts: Date.now(),
      action,
      detail: target ? `${target} · ${host}` : `tab#${tabId} · ${host}`,
    });
    await chrome.storage.local.set({ activityLog: log.slice(-50) });
  } catch {
    /* audit log is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Activity badge
// ---------------------------------------------------------------------------

const ACTIVITY_IDLE_MS = 8000;
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const recentActivity = new Map<number, { action?: string; target?: string; ts: number; task?: TaskSnapshotPayload }>();

const RESULT_BADGE_MS = { done: 4000, timeout: 6000, aborted: 6000 } as const;

/** With a task the badge stays until `task.end`; without one it falls back to idle expiry. */
async function setTabBadge(tabId: number, action?: string, target?: string, persistent = false): Promise<void> {
  const prev = badgeTimers.get(tabId);
  if (prev) clearTimeout(prev);
  badgeTimers.delete(tabId);
  try {
    await chrome.action.setBadgeText({ tabId, text: "AI" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#dc2626" });
    const label = target ? `${action ?? "working"} — ${target}` : (action ?? "agent active");
    await chrome.action.setTitle({ tabId, title: `Remora: ${label}` });
  } catch {
    return;
  }
  if (persistent) return;
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      clearTabBadge(tabId).catch(() => undefined);
    }, ACTIVITY_IDLE_MS),
  );
}

/** Task over: swap "AI" for the result mark, then clear it. */
async function showResultBadge(tabId: number, outcome: keyof typeof RESULT_BADGE_MS): Promise<void> {
  const prev = badgeTimers.get(tabId);
  if (prev) clearTimeout(prev);
  try {
    const done = outcome === "done";
    await chrome.action.setBadgeText({ tabId, text: done ? "OK" : "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: done ? "#059669" : "#b45309" });
    await chrome.action.setTitle({
      tabId,
      title: done ? "Remora: tugas agent selesai" : "Remora: agent berhenti tanpa sinyal selesai",
    });
  } catch {
    return;
  }
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      clearTabBadge(tabId).catch(() => undefined);
    }, RESULT_BADGE_MS[outcome]),
  );
}

async function clearTabBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: "Remora" });
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;

/**
 * The only way a request reaches a tab. Explicit tabId must sit in the
 * agent's group; no tabId means the agent's working tab inside the group,
 * never the window's active tab. A missing tab answers like a foreign one.
 */
async function resolveTab(agentId: string, tabId?: number): Promise<chrome.tabs.Tab> {
  const groups = await loadGroups();
  let tab: chrome.tabs.Tab | undefined;
  if (tabId !== undefined) {
    tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const verdict = checkTab(tab && toRef(tab), agentId, groups);
    if (!verdict.ok) throw wireError("OUT_OF_GROUP", verdict.message);
  } else {
    const g = groups.find((x) => x.agentId === agentId);
    const tabs = g ? await chrome.tabs.query({ groupId: g.groupId }) : [];
    const verdict = resolveImplicitTab(tabs.map(toRef), agentId, groups);
    if (!verdict.ok) throw wireError("OUT_OF_GROUP", verdict.message);
    tab = tabs.find((t) => t.id === verdict.tabId);
  }
  if (!tab?.id) throw wireError("OUT_OF_GROUP", OUT_OF_GROUP_MESSAGE);
  agentTabs.set(tab.id, agentId);
  await setWorkingTab(agentId, tab.id);
  return tab;
}

async function requireGroup(agentId: string): Promise<OwnedGroup> {
  const g = await groupFor(agentId);
  if (!g) throw wireError("OUT_OF_GROUP", NO_GROUP_TAB_MESSAGE);
  return g;
}

/** Hosts currently open in the agent's group: the cookie scope. */
async function groupTabs(g: OwnedGroup): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ groupId: g.groupId });
}

function tabRow(t: chrome.tabs.Tab) {
  return {
    id: t.id,
    windowId: t.windowId,
    title: t.title ?? "",
    url: t.url ?? "",
    active: t.active,
    pinned: t.pinned,
    audible: t.audible ?? false,
    muted: t.mutedInfo?.muted ?? false,
    status: t.status ?? "",
    groupId: t.groupId ?? TAB_GROUP_NONE,
  };
}

async function guardSite(tab: chrome.tabs.Tab): Promise<void> {
  if (isSiteBlocked(tab.url, blockedSites)) {
    throw wireError("SITE_BLOCKED", "this site is blocked by the user's kill-switch");
  }
}

/** Forward a per-tab method to the tab's content script. */
async function toContent<T>(tabId: number, method: string, params: Params): Promise<T> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "remora:call", method, params });
    if (isWireError(res)) throw res;
    return res as T;
  } catch (err) {
    if (isWireError(err)) throw err;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw wireError("NO_TAB", `tab ${tabId} not found`);
    }
    // Tabs that were already open when the extension loaded or reloaded keep
    // their document but lose the content script, so inject it once and retry
    // instead of telling the user to reload the page.
    if (supportsContentScript(tab.url)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
          injectImmediately: true,
        });
        const res = await chrome.tabs.sendMessage(tabId, { type: "remora:call", method, params });
        if (isWireError(res)) throw res;
        return res as T;
      } catch (retryErr) {
        if (isWireError(retryErr)) throw retryErr;
      }
    }
    throw wireError("NO_CONTENT_SCRIPT", `tab ${tabId} cannot be automated from here`);
  }
}

const CONTENT_METHODS = new Set([
  "snapshot",
  "page.text",
  "page.html",
  "query",
  "page.info",
  "console.logs",
  "page.errors",
  "annotate.show",
  "annotate.hide",
  "click",
  "hover",
  "type",
  "form.fill",
  "select.option",
  "set.checked",
  "scroll",
  "drag",
  "press.key",
  "focus",
  "clipboard.copyFrom",
  "clipboard.pasteTo",
  "wait.for",
  "evaluate",
  "storage.get",
  "storage.set",
  "upload.begin",
  "upload.chunk",
  "upload.inject",
  "upload.drop",
  "upload.abort",
]);

async function dispatch(method: string, params: Params, agentId: string): Promise<unknown> {
  if (CONTENT_METHODS.has(method)) {
    const tab = await resolveTab(agentId, params.tabId as number | undefined);
    await guardSite(tab);
    if (method === "evaluate" && !jsEvalEnabled) {
      throw wireError("NOT_ALLOWED", "JS eval is disabled; enable it in the Remora popup");
    }
    if (!supportsContentScript(tab.url)) {
      throw wireError("NO_CONTENT_SCRIPT", "this page cannot be automated (browser-internal page)");
    }
    return toContent(tab.id!, method, params);
  }

  switch (method) {
    // -- tabs ---------------------------------------------------------------
    case "tabs.list": {
      const { visible } = visibleTabs(await chrome.tabs.query({}), agentId, await loadGroups());
      return visible.map(tabRow);
    }
    case "tabs.resolve": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      return { tabId: tab.id, groupId: tab.groupId };
    }
    case "session.info": {
      const all = await chrome.tabs.query({});
      const g = await groupFor(agentId);
      const mine = g ? all.filter((t) => t.groupId === g.groupId) : [];
      const info = g ? await chrome.tabGroups.get(g.groupId).catch(() => null) : null;
      return {
        groupId: g?.groupId ?? null,
        title: info?.title,
        windowId: info?.windowId,
        tabIds: mine.map((t) => t.id),
        hiddenTabCount: all.length - mine.length,
      };
    }
    case "tabs.activate": {
      const tab = await resolveTab(agentId, params.tabId as number);
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tab.id };
    }
    case "tabs.create": {
      const tab = await createGroupedTab(agentId, {
        url: params.url as string | undefined,
        active: params.active as boolean | undefined,
        label: params.label as string | undefined,
      });
      agentTabs.set(tab.id!, agentId);
      scheduleBlockRebuild();
      return tabRow(tab);
    }
    case "tabs.close": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await chrome.tabs.remove(tab.id!);
      return { closed: tab.id };
    }
    case "tabs.duplicate": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      const dup = await chrome.tabs.duplicate(tab.id!);
      if (!dup?.id) throw wireError("INTERNAL", "duplicate failed");
      if (dup.groupId !== tab.groupId) await chrome.tabs.group({ groupId: tab.groupId, tabIds: dup.id });
      agentTabs.set(dup.id, agentId);
      await setWorkingTab(agentId, dup.id);
      scheduleBlockRebuild();
      return tabRow(await chrome.tabs.get(dup.id));
    }
    case "tabs.pin": {
      if (params.pinned === true) {
        throw wireError("NOT_ALLOWED", "pinning removes the tab from its Remora group");
      }
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await chrome.tabs.update(tab.id!, { pinned: false });
      return { id: tab.id, pinned: false };
    }
    case "tabs.mute": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await chrome.tabs.update(tab.id!, { muted: params.muted === true });
      return { id: tab.id, muted: params.muted === true };
    }
    case "tabs.move": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      const windowId = params.windowId as number | undefined;
      if (windowId !== undefined && windowId !== tab.windowId) {
        throw wireError("NOT_ALLOWED", "the Remora group is bound to its window; moving tabs to another window is refused");
      }
      const groupId = tab.groupId!;
      const indices = (await chrome.tabs.query({ groupId })).map((t) => t.index);
      await chrome.tabs.move(tab.id!, { index: clampIndexToGroup(params.index as number, indices) });
      const after = await chrome.tabs.get(tab.id!);
      if (after.groupId !== groupId) await chrome.tabs.group({ groupId, tabIds: tab.id! });
      return { id: tab.id, index: after.index };
    }
    case "windows.list": {
      const g = await groupFor(agentId);
      if (!g) return [];
      const info = await chrome.tabGroups.get(g.groupId).catch(() => null);
      if (!info) return [];
      const w = await chrome.windows.get(info.windowId);
      const count = (await groupTabs(g)).length;
      return [{ id: w.id, focused: w.focused, state: w.state, tabCount: count }];
    }

    // -- navigation ----------------------------------------------------------
    case "navigate": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await guardSite(tab);
      await chrome.tabs.update(tab.id!, { url: params.url as string });
      return { id: tab.id, url: params.url };
    }
    case "nav.back":
    case "nav.forward": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await guardSite(tab);
      // History traversal runs in-page; fall back gracefully.
      try {
        return await toContent(tab.id!, method, params);
      } catch (err) {
        if (isWireError(err) && err.code === "NO_CONTENT_SCRIPT") {
          await chrome.tabs.goBack(tab.id!).catch(() => undefined);
          if (method === "nav.forward") await chrome.tabs.goForward(tab.id!).catch(() => undefined);
          return { id: tab.id };
        }
        throw err;
      }
    }
    case "nav.reload": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await guardSite(tab);
      await chrome.tabs.reload(tab.id!, { bypassCache: params.hard === true });
      return { id: tab.id };
    }

    // -- visual ----------------------------------------------------------------
    case "screenshot": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      await guardSite(tab);
      return screenshotTab(tab, params);
    }
    case "export.pdf": {
      await resolveTab(agentId, params.tabId as number | undefined);
      throw wireError("NOT_ALLOWED", "PDF export needs a debugger attach; not available in this build");
    }

    // -- clipboard (background side) ---------------------------------------------
    case "clipboard.read":
    case "clipboard.write": {
      // The clipboard belongs to whatever page has focus, so only act when
      // that page is one of the agent's own tabs.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !isTabAllowed(toRef(tab), agentId, await loadGroups())) {
        throw wireError("OUT_OF_GROUP", "clipboard needs one of your Remora group tabs to be the active tab");
      }
      if (!supportsContentScript(tab.url)) {
        throw wireError("NOT_ALLOWED", "clipboard needs a regular page in the active tab");
      }
      return toContent(tab.id, method, method === "clipboard.write" ? { text: params.text } : {});
    }

    // -- cookies (scoped to sites open in the agent's group) ----------------------
    case "cookies.list":
    case "cookies.clear": {
      const g = await requireGroup(agentId);
      const urls = await cookieUrls(g, params.url as string | undefined);
      const seen = new Set<string>();
      const cookies: chrome.cookies.Cookie[] = [];
      for (const url of urls) {
        for (const c of await chrome.cookies.getAll({ url })) {
          const key = `${c.domain}|${c.path}|${c.name}|${c.storeId}`;
          if (!seen.has(key)) {
            seen.add(key);
            cookies.push(c);
          }
        }
      }
      if (method === "cookies.list") {
        return cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        }));
      }
      let removed = 0;
      for (const c of cookies) {
        const url = `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`;
        try {
          await chrome.cookies.remove({ url, name: c.name });
          removed++;
        } catch {
          /* ignore */
        }
      }
      return { removed };
    }
    case "cookies.set": {
      const g = await requireGroup(agentId);
      await cookieUrls(g, params.url as string);
      await chrome.cookies.set({
        url: params.url as string,
        name: params.name as string,
        value: params.value as string,
        expirationDate: params.expirationDate as number | undefined,
      });
      return { ok: true };
    }

    // -- network -------------------------------------------------------------------
    case "net.captureStart": {
      if (!netCaptureEnabled) {
        throw wireError("NOT_ALLOWED", "network capture is disabled; enable it in the Remora popup");
      }
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      capturingTabs.set(tab.id!, {
        pattern: params.urlPattern as string | undefined,
        entries: [],
      });
      return { capturing: tab.id };
    }
    case "net.captureStop": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      capturingTabs.delete(tab.id!);
      return { stopped: tab.id };
    }
    case "net.captureGet": {
      const tab = await resolveTab(agentId, params.tabId as number | undefined);
      const cap = capturingTabs.get(tab.id!);
      const entries = cap?.entries.slice(-500) ?? [];
      if (params.clear === true && cap) cap.entries = [];
      return { entries, capturing: !!cap };
    }
    case "net.block": {
      const g = await requireGroup(agentId);
      const patterns = Array.isArray(params.patterns) ? (params.patterns as string[]) : [];
      if (params.enabled === true && patterns.length === 0) {
        throw wireError("NOT_ALLOWED", "net_block needs at least one pattern when enabled");
      }
      const next = params.enabled === true ? patterns.slice(0, 100) : undefined;
      await updateGroups((list) => list.map((x) => (x.groupId === g.groupId ? { ...x, blockPatterns: next } : x)));
      await rebuildBlockRules();
      return { enabled: !!next, patterns: next ?? [], scope: "your Remora group" };
    }

    // -- downloads -------------------------------------------------------------------
    case "downloads.list": {
      const g = await requireGroup(agentId);
      const hosts = new Set(g.hosts);
      for (const t of await groupTabs(g)) {
        const h = hostOf(t.url);
        if (h) hosts.add(h);
      }
      const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 200 });
      return items
        .filter((d) => isDownloadInScope(d, { createdAt: g.createdAt, hosts: [...hosts] }))
        .slice(0, (params.limit as number) || 20)
        .map((d) => ({
          id: d.id,
          filename: d.filename,
          state: d.state,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          url: d.url,
        }));
    }

    default:
      throw wireError("UNKNOWN_METHOD" satisfies WireErrorCode, `not implemented: ${method}`);
  }
}

/**
 * Cookie URLs the agent may touch: one given URL inside the group's scope,
 * or every http(s) page open in the group.
 */
async function cookieUrls(g: OwnedGroup, url: string | undefined): Promise<string[]> {
  const tabUrls = (await groupTabs(g)).map((t) => t.url).filter((u): u is string => !!hostOf(u));
  const hosts = [...new Set(tabUrls.map((u) => hostOf(u)!))];
  if (url === undefined) return tabUrls;
  if (!isUrlInScope(url, hosts)) {
    throw wireError("OUT_OF_GROUP", "cookie URL is not a site open in your Remora group");
  }
  return [url];
}

// ---------------------------------------------------------------------------
// screenshots
// ---------------------------------------------------------------------------

async function screenshotTab(tab: chrome.tabs.Tab, params: Params): Promise<unknown> {
  const mode = (params.mode as string) || "viewport";
  const format = (params.format as string) === "jpeg" ? "jpeg" : "png";
  const quality = Math.min(100, Math.max(1, Number(params.quality) || 90));

  // The content script cannot rasterize; fullPage is captured by scrolling and
  // stitching later. Until that exists, fall through to the viewport capture
  // instead of returning the unsupported marker as if it were an image.
  if (mode === "fullPage") {
    const full = await toContent<{ base64?: string; mimeType?: string } | null>(
      tab.id!,
      "screenshot.fullPage",
      { format, quality },
    ).catch(() => null);
    if (full?.base64) return { ...full, mode: "fullPage", width: 0, height: 0 };
  }

  // captureVisibleTab always grabs the active tab of the window, so focus the
  // requested tab first or a background tab would screenshot the wrong page.
  if (!tab.active) {
    await chrome.tabs.update(tab.id!, { active: true });
    await new Promise((r) => setTimeout(r, 120));
  }

  // captureVisibleTab grabs whatever is visible, so make sure that is still
  // the agent's tab on both sides of the capture (the user may switch tabs).
  const stillOurs = async () =>
    (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
  if (!(await stillOurs())) throw wireError("OUT_OF_GROUP", "the visible tab changed; retry the screenshot");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: format as "png" | "jpeg",
    quality: format === "jpeg" ? quality : undefined,
  });
  if (!(await stillOurs())) throw wireError("OUT_OF_GROUP", "the visible tab changed; retry the screenshot");

  let clip: { x: number; y: number; width: number; height: number } | null = null;
  if (mode === "selector" || mode === "ref") {
    try {
      const box = await toContent<{ x: number; y: number; width: number; height: number } | null>(
        tab.id!,
        "element.box",
        { ref: params.ref, selector: params.selector },
      );
      clip = box;
    } catch {
      clip = null;
    }
  }

  const base64 = dataUrl.split(",", 2)[1] ?? "";
  return {
    base64,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    mode: clip ? mode : "viewport",
    clip,
    width: 0,
    height: 0,
  };
}

// ---------------------------------------------------------------------------
// network listeners (webRequest for observation, declarativeNetRequest for
// blocking — MV3 forbids the "blocking" webRequest mode without enterprise
// policy, and the extension must never request that permission)
// ---------------------------------------------------------------------------

function registerNetListeners(): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const cap = capturingTabs.get(details.tabId);
      if (!cap || (cap.pattern && !details.url.includes(cap.pattern))) return;
      cap.entries.push({
        id: String(details.requestId),
        method: details.method,
        url: details.url.slice(0, 2000),
        timeStamp: details.timeStamp,
        type: details.type,
      });
      if (cap.entries.length > 2000) cap.entries.splice(0, cap.entries.length - 2000);
    },
    { urls: ["http://*/*", "https://*/*"] },
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const cap = capturingTabs.get(details.tabId);
      if (!cap) return;
      const entry = cap.entries.find((e) => e.id === String(details.requestId));
      if (entry) {
        entry.statusCode = details.statusCode;
        entry.durationMs = Math.round(details.timeStamp - entry.timeStamp);
      }
      completedAt.set(String(details.requestId), details.timeStamp);
    },
    { urls: ["http://*/*", "https://*/*"] },
  );
}

const BLOCK_RULE_BASE = 10_000;
// Chrome exposes these as string values, not runtime enum objects, so the
// literals are cast to the declared enum types instead of dereferenced.
const BLOCK_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
] as unknown as chrome.declarativeNetRequest.ResourceType[];

async function clearLegacyBlockRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= BLOCK_RULE_BASE).map((r) => r.id);
  if (removeRuleIds.length > 0) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
}

let blockRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Group membership changed; rules carry tab ids, so refresh them soon. */
function scheduleBlockRebuild(): void {
  if (blockRebuildTimer) clearTimeout(blockRebuildTimer);
  blockRebuildTimer = setTimeout(() => {
    blockRebuildTimer = null;
    void rebuildBlockRules().catch(() => undefined);
  }, 300);
}

/**
 * Per-group blocking: session rules with a `tabIds` condition (only session
 * rules support it), so one agent's block list never reaches the user's or
 * another agent's tabs.
 */
async function rebuildBlockRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.filter((r) => r.id >= BLOCK_RULE_BASE).map((r) => r.id);
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  for (const g of await loadGroups()) {
    if (!g.blockPatterns?.length) continue;
    const tabIds = (await chrome.tabs.query({ groupId: g.groupId })).map((t) => t.id!).filter((id) => id >= 0);
    if (tabIds.length === 0) continue;
    for (const pattern of g.blockPatterns) {
      addRules.push({
        id: BLOCK_RULE_BASE + addRules.length,
        priority: 1,
        action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
        condition: { urlFilter: pattern, resourceTypes: BLOCK_RESOURCE_TYPES, tabIds },
      });
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}
