/**
 * Content-script: agent-presence overlays.
 *
 * - Pill: floating status pill ("Remora · agent aktif" + last action),
 *   Shadow DOM isolated, pointer-events none. Lit from the first tool call
 *   until the task ends (task_end, idle watchdog, or session close); the
 *   result (done / cut off) then shows for a few seconds and clears.
 * - Highlight: 1.2s amber outline + glow on the element being acted upon.
 * - Annotate: numbered badges over interactive elements for grounding.
 * - Title: `🟢 [Agent] ` prefix while the agent session is active.
 * - Favicon: teal-dot badge composited over the site favicon.
 *
 * All layers are strictly informational (no buttons, no interception).
 */

import { annotatedElements } from "./snapshot.js";

const TEAL = "#0d9488";
const HIGHLIGHT = "#f59e0b";

let pillHost: HTMLElement | null = null;
let pillBox: HTMLElement | null = null;
let pillLine1: HTMLElement | null = null;
let pillLine2: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle: string | null = null;

export interface TaskInfo {
  label?: string;
  startedAt: number;
  step: number;
}
export type TaskOutcome = "done" | "timeout" | "aborted";

const DONE_SHOW_MS = 4000;
const CUT_SHOW_MS = 6000;

function ensurePill(): void {
  if (pillHost) return;
  pillHost = document.createElement("div");
  pillHost.id = "remora-pill-root";
  const shadow = pillHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .pill { position: fixed; right: 16px; top: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      background: rgba(4,33,30,.88); color: #eafffb;
      border: 1px solid rgba(13,148,136,.5); border-radius: 999px;
      padding: 6px 12px 6px 8px; pointer-events: none;
      font: 500 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.4);
      opacity: 1; transition: opacity .5s ease; max-width: min(420px, 60vw); }
    .pill.hidden { opacity: 0; }
    .pill.hidden .ring, .pill.hidden .ring2 { animation: none; }
    .pill.done { background: rgba(6,40,28,.94); border-color: rgba(52,211,153,.7); color: #eafff4; }
    .pill.cut { background: rgba(48,32,4,.94); border-color: rgba(251,191,36,.75); color: #fff6dc; }
    .pill.done .dot { background: #34d399; box-shadow: none; animation: none; }
    .pill.cut .dot { background: #fbbf24; box-shadow: none; animation: none; }
    .pill.done .ring, .pill.done .ring2, .pill.cut .ring, .pill.cut .ring2 { display: none; }
    .pill.done .act { color: #86efc0; } .pill.cut .act { color: #fcd34d; }
    .pill { overflow: visible; }
    .dotwrap { position: relative; width: 10px; height: 10px; flex: none; overflow: visible; }
    .dot { position: absolute; inset: 0; border-radius: 50%; background: #2dd4bf;
      box-shadow: 0 0 6px rgba(45,212,191,.9); animation: dotpulse 1s ease-in-out infinite; }
    @keyframes dotpulse { 50% { box-shadow: 0 0 10px rgba(45,212,191,1); } }
    .ring, .ring2 { position: absolute; left: 50%; top: 50%; width: 20vw; height: 20vw;
      border: 2.5px solid rgba(45,212,191,.85); border-radius: 50%;
      background: rgba(45,212,191,.06);
      box-shadow: 0 0 12px rgba(45,212,191,.35), inset 0 0 12px rgba(45,212,191,.15);
      transform: translate(-50%,-50%) scale(.02); opacity: 0;
      animation: radar 1s ease-out infinite; pointer-events: none; }
    .ring2 { animation-delay: .5s; }
    @keyframes radar {
      0% { transform: translate(-50%,-50%) scale(.02); opacity: .95; }
      100% { transform: translate(-50%,-50%) scale(1); opacity: 0; } }
    .txt { display: flex; flex-direction: column; min-width: 0; }
    .l1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .act { color: #7ff0e2; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  `;
  pillBox = document.createElement("div");
  pillBox.className = "pill hidden";
  const dotwrap = document.createElement("span");
  dotwrap.className = "dotwrap";
  const dot = document.createElement("span");
  dot.className = "dot";
  const ring = document.createElement("span");
  ring.className = "ring";
  const ring2 = document.createElement("span");
  ring2.className = "ring2";
  dotwrap.append(dot, ring, ring2);
  const txt = document.createElement("span");
  txt.className = "txt";
  pillLine1 = document.createElement("span");
  pillLine1.className = "l1";
  pillLine2 = document.createElement("span");
  pillLine2.className = "act";
  txt.append(pillLine1, pillLine2);
  pillBox.append(dotwrap, txt);
  shadow.append(style, pillBox);
  document.documentElement.appendChild(pillHost);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function setLine1(strong: string, label?: string): void {
  if (!pillLine1) return;
  pillLine1.textContent = "";
  const b = document.createElement("strong");
  b.textContent = strong;
  pillLine1.append(b);
  if (label) pillLine1.append(` — ${label}`);
}

function stopTick(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/**
 * Render an in-progress task. The pill stays lit until `showTaskEnd`; without
 * task info (legacy notification) it still shows, but is never silently faded.
 */
export function showActivity(action: string, target?: string, task?: TaskInfo): void {
  ensurePill();
  const pill = pillBox;
  if (!pill || !pillLine2) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  resultBase = null;
  pill.classList.remove("hidden", "done", "cut");
  setLine1("Remora · agent bekerja", task?.label);
  const last = [action, target?.slice(0, 60)].filter(Boolean).join(" · ");
  const render = () => {
    const head = task ? `langkah ${task.step} · ${fmtElapsed(Date.now() - task.startedAt)} · ` : "";
    if (pillLine2) pillLine2.textContent = head + last;
  };
  render();
  stopTick();
  if (task) tickTimer = setInterval(render, 1000);
  prefixTitle(true);
}

/** Release the in-use markers at once; show the result briefly, then clear. */
export function showTaskEnd(outcome: TaskOutcome, label: string | undefined, steps: number, durationMs: number): void {
  ensurePill();
  const pill = pillBox;
  if (!pill || !pillLine2) return;
  stopTick();
  if (hideTimer) clearTimeout(hideTimer);
  prefixTitle(false);
  const done = outcome === "done";
  pill.classList.remove("hidden", "done", "cut");
  pill.classList.add(done ? "done" : "cut");
  if (done) {
    setLine1("Remora · selesai ✓", label);
    pillLine2.textContent = `${steps} langkah · ${fmtElapsed(durationMs)}`;
  } else {
    setLine1(outcome === "aborted" ? "Remora · sesi agent ditutup" : "Remora · agent berhenti", outcome === "aborted" ? undefined : "tanpa sinyal selesai");
    pillLine2.textContent = `${steps} langkah · ${fmtElapsed(durationMs)}`;
  }
  resultTitle(done ? "✅ " : "⚠️ ");
  hideTimer = setTimeout(
    () => {
      pill.classList.add("hidden");
      resultTitle(null);
    },
    done ? DONE_SHOW_MS : CUT_SHOW_MS,
  );
}

/** Access revoked (tab dragged out of the group): drop every marker now. */
export function releaseIndicators(): void {
  stopTick();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  prefixTitle(false);
  resultTitle(null);
  pillBox?.classList.add("hidden");
}

/** Result marker on the title (✅/⚠️); null restores the page's own title. */
function resultTitle(prefix: string | null): void {
  if (prefix) {
    const base = stripPrefix(document.title);
    resultBase = base;
    document.title = `${prefix}${base}`;
  } else if (resultBase !== null) {
    document.title = resultBase;
    resultBase = null;
  }
}
let resultBase: string | null = null;

// ---------------------------------------------------------------------------
// title prefix (with MutationObserver for SPA title churn)
// ---------------------------------------------------------------------------

let titleObserver: MutationObserver | null = null;
let faviconLink: HTMLLinkElement | null = null;
let originalFavicon: string | null = null;

const TITLE_PREFIX = "🟢 [Agent] ";

function prefixTitle(on: boolean): void {
  if (on) {
    if (originalTitle === null) originalTitle = stripPrefix(document.title);
    if (!document.title.startsWith(TITLE_PREFIX)) document.title = `${TITLE_PREFIX}${stripPrefix(document.title)}`;
    setFavicon(true);
    if (!titleObserver) {
      titleObserver = new MutationObserver(() => {
        if (originalTitle !== null && !document.title.startsWith(TITLE_PREFIX)) {
          originalTitle = stripPrefix(document.title);
          document.title = `${TITLE_PREFIX}${originalTitle}`;
        }
      });
      const titleEl = document.querySelector("title");
      if (titleEl) titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } else if (originalTitle !== null) {
    document.title = originalTitle;
    originalTitle = null;
    setFavicon(false);
    titleObserver?.disconnect();
    titleObserver = null;
  }
}

function stripPrefix(title: string): string {
  // Toleransi prefix lama ("● ") agar migrasi mulus.
  return title.replace(/^(🟢 \[Agent\] |✅ |⚠️ |● )/, "");
}

/** Tempel dot teal pada favicon tab; kembalikan aslinya saat sesi selesai. */
function setFavicon(on: boolean): void {
  try {
    if (on) {
      if (faviconLink) return;
      const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (existing?.href) originalFavicon = existing.href;
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, 64, 64);
          ctx.beginPath();
          ctx.arc(50, 50, 14, 0, Math.PI * 2);
          ctx.fillStyle = TEAL;
          ctx.fill();
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
          applyFavicon(canvas.toDataURL("image/png"));
        } catch {
          // Canvas tercemar (favicon cross-origin tanpa CORS): fallback lingkaran polos.
          drawPlainBadge(ctx, canvas);
        }
      };
      img.onerror = () => drawPlainBadge(ctx, canvas);
      img.src = originalFavicon ?? "/favicon.ico";
      // Fallback sinkron bila gambar tak termuat (mis. CSP ketat).
      setTimeout(() => {
        if (!faviconLink) drawPlainBadge(ctx, canvas);
      }, 1000);
    } else if (faviconLink) {
      faviconLink.remove();
      faviconLink = null;
      originalFavicon = null;
    }
  } catch {
    /* favicon adalah penanda best-effort */
  }
}

function applyFavicon(href: string): void {
  if (faviconLink) return;
  faviconLink = document.createElement("link");
  faviconLink.rel = "icon";
  faviconLink.href = href;
  (document.head ?? document.documentElement).appendChild(faviconLink);
}

/** Badge teal polos bila favicon asli tak bisa digambar ulang. */
function drawPlainBadge(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  if (faviconLink) return;
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.fillStyle = TEAL;
    ctx.fill();
    applyFavicon(canvas.toDataURL("image/png"));
  } catch {
    /* abaikan: favicon tetap asli */
  }
}

// ---------------------------------------------------------------------------
// highlight pulse
// ---------------------------------------------------------------------------

export function flashHighlight(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  const prevShadow = el.style.boxShadow;
  el.style.outline = `3px solid ${HIGHLIGHT}`;
  el.style.outlineOffset = "2px";
  el.style.boxShadow = `0 0 0 5px rgba(245,158,11,.35), 0 0 14px rgba(245,158,11,.7)`;
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
    el.style.boxShadow = prevShadow;
  }, 1200);
}

// ---------------------------------------------------------------------------
// annotate overlay (numbered badges for grounding)
// ---------------------------------------------------------------------------

let annotateRoot: HTMLElement | null = null;

export function showAnnotate(): { badges: number } {
  hideAnnotate();
  annotateRoot = document.createElement("div");
  annotateRoot.id = "remora-annotate-root";
  const shadow = annotateRoot.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .badge { position: fixed; z-index: 2147483646; pointer-events: none;
      background: ${TEAL}; color: #fff; font: 700 10px/1 system-ui, sans-serif;
      min-width: 18px; height: 18px; border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 4px; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
    .box { position: fixed; z-index: 2147483645; pointer-events: none;
      border: 1px solid ${TEAL}; border-radius: 3px; }
  `;
  shadow.append(style);
  const els = annotatedElements();
  for (const e of els) {
    const box = document.createElement("div");
    box.className = "box";
    box.style.cssText += `left:${e.box.x}px;top:${e.box.y}px;width:${e.box.width}px;height:${e.box.height}px;`;
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = e.ref.replace(/^e/, "");
    badge.style.cssText += `left:${Math.max(0, e.box.x - 4)}px;top:${Math.max(0, e.box.y - 20)}px;`;
    badge.title = `${e.ref} ${e.role} ${e.name}`;
    shadow.append(box, badge);
  }
  document.documentElement.appendChild(annotateRoot);
  return { badges: els.length };
}

export function hideAnnotate(): void {
  annotateRoot?.remove();
  annotateRoot = null;
}
