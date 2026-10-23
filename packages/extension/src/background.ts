/**
 * Remora background service worker (MV3, ESM).
 *
 * - Owns the WebSocket client to the MCP hub (ws://127.0.0.1:PORT/remora).
 * - Routes wire methods: background-implemented (tabs, navigation capture,
 *   cookies, downloads, screenshots) vs content-routed (per-tab DOM work).
 * - Tracks per-tab state for the activity UI (badge, pending notifications).
 */

import {
  DEFAULT_WS_PORT,
  WS_PATH,
  WireErrorCode,
  parseWireFrame,
  validateMethodParams,
} from "@remora/protocol";
import { isSiteBlocked, isWireError, loadSettings, saveSettings, wireError } from "./shared.js";

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
let settingsPort = DEFAULT_WS_PORT;
let jsEvalEnabled = false;
let netCaptureEnabled = false;
let blockedSites: string[] = [];

const capturingTabs = new Map<number, { pattern?: string; entries: NetEntry[] }>();
const completedAt = new Map<string, number>();
let blockPatterns: string[] = [];
let blockEnabled = false;

// Content-script readiness + upload staging live in each tab's content
// script; background only forwards messages and reports errors.

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function refreshSettings(): Promise<void> {
  const s = await loadSettings();
  settingsToken = s.token;
  settingsPort = s.port;
  jsEvalEnabled = s.jsEvalEnabled;
  netCaptureEnabled = s.netCaptureEnabled;
  blockedSites = s.blockedSites;
  blockEnabled = s.netBlockEnabled;
  blockPatterns = s.netBlockPatterns;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  void (async () => {
    const tokenChanged = changes.token && changes.token.newValue !== settingsToken;
    const portChanged = changes.port && Number(changes.port.newValue) !== settingsPort;
    await refreshSettings();
    if (tokenChanged || portChanged) connect();
  })();
});

chrome.runtime.onStartup.addListener(() => void boot());
chrome.runtime.onInstalled.addListener(() => void boot());
void boot();

async function boot(): Promise<void> {
  await refreshSettings();
  registerNetListeners();
  // Rules survive worker restarts; re-apply them from persisted settings so a
  // stale block list can never outlive the user turning blocking off.
  await updateBlockingRules().catch(() => undefined);
  connect();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturingTabs.delete(tabId);
  sendEvent("tab_closed", { tabId });
  clearTabBadge(tabId).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url && tab.title) {
    sendEvent("navigated", { tabId, url: tab.url, title: tab.title });
  }
});

// Popup bridge: status queries, manual reconnect, audit-log reads.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const type = (msg as { type?: string }).type;
  if (type === "remora:status") {
    sendResponse({ connected: wsReady && !!ws && ws.readyState === WebSocket.OPEN, latencyMs: lastLatencyMs });
    return false;
  }
  if (type === "remora:reconnect") {
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

let lastLatencyMs: number | undefined;
let lastPingAt = 0;
void lastPingAt;

// MV3 suspends the worker, so the socket can drop while idle; an alarms tick
// reconnects it without relying on the worker staying alive.
if (chrome.alarms) {
  chrome.alarms.create("remora-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "remora-keepalive" && (!ws || ws.readyState !== WebSocket.OPEN)) {
      connect();
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

function wsUrl(): string {
  return `ws://127.0.0.1:${settingsPort}${WS_PATH}?token=${encodeURIComponent(settingsToken)}`;
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
  wsReady = false;
  if (!settingsToken) return; // unpaired: popup will supply the token

  const socket = new WebSocket(wsUrl());
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    wsReady = true;
    reconnectDelayMs = 1000;
    void chrome.tabs.query({}).then((tabs) => {
      sendEvent("hello", {
        version: chrome.runtime.getManifest().version,
        protocol: 1,
        tabCount: tabs.length,
      });
    });
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    void handleFrame(String(ev.data));
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    wsReady = false;
    ws = null;
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* handled by onclose */
    }
  };
}

/** Drop handlers so a superseded socket cannot mutate current state. */
function detach(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(
    () => {
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      connect();
    },
    reconnectDelayMs + Math.floor(Math.random() * 500),
  );
}

function send(obj: unknown): void {
  if (ws && wsReady && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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
    const { id, method, params } = frame.value;
    const check = validateMethodParams(method, params ?? {});
    if (!check.ok) {
      send({ id, ok: false, error: { code: "BAD_ARGS", message: check.message } });
      return;
    }
    try {
      const result = await dispatch(method, (params ?? {}) as Record<string, unknown>);
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
    const p = payload as { tabId?: number; action?: string; target?: string };
    if (typeof p?.tabId !== "number") return;
    void setTabBadge(p.tabId, p.action, p.target);
    void appendActivityLog(p.tabId, p.action ?? "working", p.target);
    void chrome.tabs
      .sendMessage(p.tabId, { type: "remora:activity", action: p.action, target: p.target })
      .catch(() => undefined);
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

const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function setTabBadge(tabId: number, action?: string, target?: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: "AI" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#dc2626" });
    const label = target ? `${action ?? "working"} — ${target}` : (action ?? "agent active");
    await chrome.action.setTitle({ tabId, title: `Remora: ${label}` });
  } catch {
    return;
  }
  const prev = badgeTimers.get(tabId);
  if (prev) clearTimeout(prev);
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      clearTabBadge(tabId).catch(() => undefined);
    }, 8000),
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

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]?.id) throw wireError("NO_TAB", "no active tab");
  return tabs[0].id;
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = tabId ?? (await activeTabId());
  try {
    return await chrome.tabs.get(id);
  } catch {
    throw wireError("NO_TAB", `tab ${id} not found`);
  }
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

async function dispatch(method: string, params: Params): Promise<unknown> {
  if (CONTENT_METHODS.has(method)) {
    const tab = await resolveTab(params.tabId as number | undefined);
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
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active,
        pinned: t.pinned,
        audible: t.audible ?? false,
        muted: t.mutedInfo?.muted ?? false,
        status: t.status ?? "",
      }));
    }
    case "tabs.activate": {
      const tab = await resolveTab(params.tabId as number);
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tab.id };
    }
    case "tabs.create": {
      const tab = await chrome.tabs.create({
        url: (params.url as string) || undefined,
        active: params.active !== false,
        windowId: params.windowId as number | undefined,
      });
      return {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        active: tab.active,
        pinned: tab.pinned,
      };
    }
    case "tabs.close": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await chrome.tabs.remove(tab.id!);
      return { closed: tab.id };
    }
    case "tabs.duplicate": {
      const tab = await resolveTab(params.tabId as number | undefined);
      const dup = await chrome.tabs.duplicate(tab.id!);
      return { id: dup?.id, windowId: dup?.windowId, title: dup?.title ?? "", url: dup?.url ?? "" };
    }
    case "tabs.pin": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await chrome.tabs.update(tab.id!, { pinned: params.pinned === true });
      return { id: tab.id, pinned: params.pinned === true };
    }
    case "tabs.mute": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await chrome.tabs.update(tab.id!, { muted: params.muted === true });
      return { id: tab.id, muted: params.muted === true };
    }
    case "tabs.move": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await chrome.tabs.move(tab.id!, {
        index: params.index as number,
        windowId: params.windowId as number | undefined,
      });
      return { id: tab.id };
    }
    case "windows.list": {
      const wins = await chrome.windows.getAll({ populate: true });
      return wins.map((w) => ({
        id: w.id,
        focused: w.focused,
        state: w.state,
        tabCount: w.tabs?.length ?? 0,
      }));
    }

    // -- navigation ----------------------------------------------------------
    case "navigate": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await guardSite(tab);
      await chrome.tabs.update(tab.id!, { url: params.url as string });
      return { id: tab.id, url: params.url };
    }
    case "nav.back":
    case "nav.forward": {
      const tab = await resolveTab(params.tabId as number | undefined);
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
      const tab = await resolveTab(params.tabId as number | undefined);
      await guardSite(tab);
      await chrome.tabs.reload(tab.id!, { bypassCache: params.hard === true });
      return { id: tab.id };
    }

    // -- visual ----------------------------------------------------------------
    case "screenshot": {
      const tab = await resolveTab(params.tabId as number | undefined);
      await guardSite(tab);
      return screenshotTab(tab, params);
    }
    case "export.pdf": {
      throw wireError("NOT_ALLOWED", "PDF export needs a debugger attach; not available in this build");
    }

    // -- clipboard (background side) ---------------------------------------------
    case "clipboard.read": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !supportsContentScript(tab.url)) {
        throw wireError("NOT_ALLOWED", "clipboard read needs a regular page in the active tab");
      }
      return toContent(tab.id, "clipboard.read", {});
    }
    case "clipboard.write": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw wireError("NO_TAB", "no active tab");
      if (!supportsContentScript(tab.url)) {
        // Offscreen-free fallback: use the active tab via scripting.
        throw wireError("NOT_ALLOWED", "clipboard write needs a regular page in the active tab");
      }
      return toContent(tab.id, "clipboard.write", { text: params.text });
    }

    // -- cookies ------------------------------------------------------------------
    case "cookies.list": {
      const cookies = await chrome.cookies.getAll(
        params.url ? { url: params.url as string } : {},
      );
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
    case "cookies.set": {
      await chrome.cookies.set({
        url: params.url as string,
        name: params.name as string,
        value: params.value as string,
        expirationDate: params.expirationDate as number | undefined,
      });
      return { ok: true };
    }
    case "cookies.clear": {
      const cookies = await chrome.cookies.getAll(
        params.url ? { url: params.url as string } : {},
      );
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

    // -- network -------------------------------------------------------------------
    case "net.captureStart": {
      if (!netCaptureEnabled) {
        throw wireError("NOT_ALLOWED", "network capture is disabled; enable it in the Remora popup");
      }
      const tab = await resolveTab(params.tabId as number | undefined);
      capturingTabs.set(tab.id!, {
        pattern: params.urlPattern as string | undefined,
        entries: [],
      });
      return { capturing: tab.id };
    }
    case "net.captureStop": {
      const tab = await resolveTab(params.tabId as number | undefined);
      capturingTabs.delete(tab.id!);
      return { stopped: tab.id };
    }
    case "net.captureGet": {
      const tab = await resolveTab(params.tabId as number | undefined);
      const cap = capturingTabs.get(tab.id!);
      const entries = cap?.entries.slice(-500) ?? [];
      if (params.clear === true && cap) cap.entries = [];
      return { entries, capturing: !!cap };
    }
    case "net.block": {
      const patterns = Array.isArray(params.patterns) ? (params.patterns as string[]) : [];
      if (params.enabled === true && patterns.length === 0) {
        throw wireError("NOT_ALLOWED", "net_block needs at least one pattern when enabled");
      }
      blockPatterns = params.enabled === true ? patterns : [];
      blockEnabled = params.enabled === true;
      await updateBlockingRules();
      await saveSettings({ netBlockEnabled: blockEnabled, netBlockPatterns: blockPatterns });
      return { enabled: blockEnabled, patterns: blockPatterns };
    }

    // -- downloads -------------------------------------------------------------------
    case "downloads.list": {
      const items = await chrome.downloads.search({
        orderBy: ["-startTime"],
        limit: (params.limit as number) || 20,
      });
      return items.map((d) => ({
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

function supportsContentScript(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
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

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: format as "png" | "jpeg",
    quality: format === "jpeg" ? quality : undefined,
  });

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

async function updateBlockingRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= BLOCK_RULE_BASE).map((r) => r.id);
  const addRules: chrome.declarativeNetRequest.Rule[] = blockEnabled
    ? blockPatterns.slice(0, 500).map((pattern, i) => ({
        id: BLOCK_RULE_BASE + i,
        priority: 1,
        action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
        condition: { urlFilter: pattern, resourceTypes: BLOCK_RESOURCE_TYPES },
      }))
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}
