/**
 * Remora popup logic: connection state, pairing token, gates, per-site
 * kill-switch, and the agent activity audit log.
 * Visual system follows design/Remora Popup.html (Operate surface).
 */

import { loadSettings, saveSettings, originOf } from "./shared.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

interface LogEntry {
  ts: number;
  action: string;
  detail: string;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    // Fallback for clipboard-denied contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(okMsg);
    } catch {
      toast("Gagal menyalin");
    }
    ta.remove();
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mcpConfig(token: string, port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        remora: {
          command: "node",
          args: ["D:/Dev/Claude/Projects/Remora/packages/mcp-server/dist/index.js"],
          env: { REMORA_TOKEN: token, REMORA_PORT: String(port) },
        },
      },
    },
    null,
    2,
  );
}

type ConnState = "connected" | "disconnected" | "connecting" | "pairing";

interface ConnStatus {
  phase: "unpaired" | "connecting" | "connected" | "retrying";
  connected: boolean;
  port: number;
  attempt: number;
  lastError: { code: string; message: string; at: number } | null;
  nextRetryAt: number | null;
  latencyMs?: number;
  tokenId: string | null;
  hubTokenId: string | null;
}

function setState(state: ConnState, label: string): void {
  $("popup").dataset.state = state;
  $("conn-label").textContent = label;
}

let reconnecting = false;

async function fetchStatus(): Promise<ConnStatus | null> {
  return (await chrome.runtime.sendMessage({ type: "remora:status" }).catch(() => null)) as ConnStatus | null;
}

function renderStatus(status: ConnStatus | null, port: number): void {
  $("ws-addr").textContent = `127.0.0.1:${port}`;
  $("ws-lat").textContent = status?.connected && status.latencyMs !== undefined ? `${status.latencyMs} ms` : "—";
  $("ws-tok").textContent = status?.tokenId ? `#${status.tokenId}` : "—";
  if (!status) {
    setState("disconnected", "Terputus");
    $("banner-msg").textContent = "Service worker Remora tidak merespons. Muat ulang extension di chrome://extensions.";
    $("banner-sub").textContent = "";
    return;
  }
  if (status.phase === "unpaired") {
    setState("pairing", "Pairing");
    return;
  }
  if (status.connected) {
    setState("connected", "Terhubung");
    return;
  }
  const busy = reconnecting || status.phase === "connecting";
  setState(busy ? "connecting" : "disconnected", busy ? "Menghubungkan…" : "Terputus");
  $("banner-msg").textContent = status.lastError?.message ?? "Menghubungkan ke MCP server…";
  const sub: string[] = [];
  if (status.nextRetryAt && !busy) {
    sub.push(`Coba otomatis dalam ${Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 1000))} dtk`);
  }
  if (status.attempt > 1) sub.push(`percobaan ke-${status.attempt}`);
  if (status.lastError?.code === "BAD_TOKEN" && status.tokenId) sub.push(`token extension #${status.tokenId}`);
  $("banner-sub").textContent = sub.join(" · ");
}

async function refreshConnection(): Promise<void> {
  const s = await loadSettings();
  renderStatus(await fetchStatus(), s.port);
}

async function reconnect(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  const btn = $("btn-reconnect") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Menghubungkan…";
  await refreshConnection();
  const status = (await chrome.runtime
    .sendMessage({ type: "remora:reconnect" })
    .catch(() => null)) as ConnStatus | null;
  reconnecting = false;
  btn.disabled = false;
  btn.textContent = "Reconnect";
  const s = await loadSettings();
  renderStatus(status, s.port);
  if (status?.connected) toast("Terhubung ✓");
  else if (status?.phase === "unpaired") toast("Tempel token dulu");
  else toast("Gagal terhubung — lihat pesan di atas");
}

async function saveToken(raw: string): Promise<void> {
  const token = raw.trim();
  const cur = await loadSettings();
  if (token === cur.token) return;
  if (token.length < 16) {
    toast("Token minimal 16 karakter");
    return;
  }
  await saveSettings({ token });
  $("pairing-config").textContent = mcpConfig(token, cur.port);
  toast("Token disimpan");
  await reconnect();
}

function renderToken(token: string): void {
  ($("token") as HTMLInputElement).value = token;
}

function renderToggles(js: boolean, net: boolean): void {
  ($("tgl-js") as HTMLInputElement).checked = js;
  ($("tgl-net") as HTMLInputElement).checked = net;
  const tagJs = $("tag-js");
  tagJs.textContent = js ? "ON" : "OFF";
  tagJs.className = `pill-tag ${js ? "on" : "off"}`;
  const tagNet = $("tag-net");
  tagNet.textContent = net ? "ON" : "OFF";
  tagNet.className = `pill-tag ${net ? "on" : "off"}`;
}

async function renderSites(blocked: string[]): Promise<void> {
  const list = $("site-list");
  list.innerHTML = "";
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeOrigin = originOf(active?.url);
  if (activeOrigin) {
    const row = document.createElement("div");
    row.className = "site-row";
    const isBlocked = blocked.includes(activeOrigin);
    row.innerHTML =
      `<span class="host"></span><span class="you">tab aktif</span>` +
      `<span class="pill-tag ${isBlocked ? "blocked" : "on"}">${isBlocked ? "Diblokir" : "Diizinkan"}</span>`;
    row.querySelector(".host")!.textContent = activeOrigin;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-sm ${isBlocked ? "btn-ghost" : "btn-danger-ghost"}`;
    btn.textContent = isBlocked ? "Buka" : "Blokir";
    btn.addEventListener("click", async () => {
      const s = await loadSettings();
      const next = isBlocked
        ? s.blockedSites.filter((b) => b !== activeOrigin)
        : [...s.blockedSites, activeOrigin];
      await saveSettings({ blockedSites: next });
      toast(isBlocked ? "Situs dibuka" : "Situs diblokir — agent dihentikan");
      void renderSites(next);
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  const others = blocked.filter((b) => b !== activeOrigin);
  for (const origin of others) {
    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = `<span class="host"></span><span class="pill-tag blocked">Diblokir</span>`;
    row.querySelector(".host")!.textContent = origin;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = "Buka";
    btn.addEventListener("click", async () => {
      const s = await loadSettings();
      const next = s.blockedSites.filter((b) => b !== origin);
      await saveSettings({ blockedSites: next });
      toast("Situs dibuka");
      void renderSites(next);
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  if (!activeOrigin && others.length === 0) {
    list.innerHTML = `<div class="site-empty">Tidak ada situs diblokir.</div>`;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

async function renderLog(): Promise<void> {
  const stored = await chrome.storage.local.get({ activityLog: [] });
  const entries = (stored.activityLog as LogEntry[]).slice(-8).reverse();
  const body = $("log-body");
  body.innerHTML = "";
  $("log").classList.toggle("is-empty", entries.length === 0);
  for (const e of entries) {
    const tr = document.createElement("tr");
    const t = document.createElement("td");
    t.className = "t";
    t.textContent = fmtTime(e.ts);
    const a = document.createElement("td");
    a.className = "a";
    a.textContent = e.action;
    const g = document.createElement("td");
    g.className = "g";
    g.textContent = e.detail;
    g.title = e.detail;
    tr.append(t, a, g);
    body.appendChild(tr);
  }
}

async function init(): Promise<void> {
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  const s = await loadSettings();
  renderToken(s.token);
  renderToggles(s.jsEvalEnabled, s.netCaptureEnabled);
  $("pairing-config").textContent = mcpConfig(s.token || "***", s.port);
  await refreshConnection();
  await renderSites(s.blockedSites);
  await renderLog();

  // The worker reconnects in the background, so a one-shot read can show a
  // stale "Terputus" for as long as the popup stays open.
  const poll = setInterval(() => {
    if (!reconnecting) void refreshConnection();
  }, 1000);
  window.addEventListener("unload", () => clearInterval(poll));

  $("btn-reconnect").addEventListener("click", () => void reconnect());
  const tokenInput = $("token") as HTMLInputElement;
  tokenInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void saveToken(tokenInput.value);
  });
  tokenInput.addEventListener("change", () => void saveToken(tokenInput.value));
  $("btn-show").addEventListener("click", () => {
    const input = $("token") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
  });
  $("btn-copy-token").addEventListener("click", () => {
    const token = ($("token") as HTMLInputElement).value;
    if (!token) return toast("Belum ada token");
    void copyText(token, "Token disalin");
  });
  $("btn-copy-config").addEventListener("click", async () => {
    const cur = await loadSettings();
    if (!cur.token) return toast("Buat token dulu (Regenerate)");
    void copyText(mcpConfig(cur.token, cur.port), "Config MCP disalin");
  });
  $("btn-regen").addEventListener("click", async () => {
    const ok = confirm(
      "Buat token baru?\n\nSemua MCP client (Claude / ZCode) harus memakai token baru ini " +
        "(Copy MCP config JSON → restart client). Sampai itu dilakukan, Remora tidak akan terhubung.",
    );
    if (!ok) return;
    const token = randomToken();
    await saveSettings({ token });
    renderToken(token);
    const cur = await loadSettings();
    $("pairing-config").textContent = mcpConfig(token, cur.port);
    await copyText(mcpConfig(token, cur.port), "Config baru disalin — pasang di MCP client");
    await refreshConnection();
  });
  $("tgl-js").addEventListener("change", async (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    await saveSettings({ jsEvalEnabled: on });
    const cur = await loadSettings();
    renderToggles(cur.jsEvalEnabled, cur.netCaptureEnabled);
    toast(`JS eval ${on ? "diaktifkan" : "dimatikan"}`);
  });
  $("tgl-net").addEventListener("change", async (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    await saveSettings({ netCaptureEnabled: on });
    const cur = await loadSettings();
    renderToggles(cur.jsEvalEnabled, cur.netCaptureEnabled);
    toast(`Network capture ${on ? "diaktifkan" : "dimatikan"}`);
  });
  $("btn-clear").addEventListener("click", async () => {
    await chrome.storage.local.set({ activityLog: [] });
    await renderLog();
    toast("Log dibersihkan");
  });
  $("docs-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    void chrome.tabs.create({ url: "https://github.com" });
    toast("Docs: lihat docs/ di repo Remora");
  });
}

void init();
