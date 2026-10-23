/**
 * Content-script: agent-presence overlays.
 *
 * - Pill: floating status pill ("Remora · agent aktif" + last action),
 *   Shadow DOM isolated, pointer-events none, auto-fades after 8s idle.
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
let pillAction: HTMLElement | null = null;
let pillTarget: HTMLElement | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let originalTitle: string | null = null;

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
    .pill.idle { opacity: .7; } .pill.hidden { opacity: 0; }
    .pill.hidden .ring, .pill.hidden .ring2 { animation: none; }
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
    .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .act { color: #7ff0e2; }
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
  const brand = document.createElement("strong");
  brand.textContent = "Remora · agent aktif";
  pillAction = document.createElement("span");
  pillAction.className = "act";
  pillTarget = document.createElement("span");
  txt.append(brand, pillAction, pillTarget);
  pillBox.append(dotwrap, txt);
  shadow.append(style, pillBox);
  document.documentElement.appendChild(pillHost);
}

/** Show/update the pill with the latest agent action; schedules fade. */
export function showActivity(action: string, target?: string): void {
  ensurePill();
  const pill = pillBox;
  if (!pill || !pillAction || !pillTarget) return;
  pillAction.textContent = action ? ` — ${action}` : "";
  pillTarget.textContent = target ? ` · ${target.slice(0, 60)}` : "";
  pill.classList.remove("hidden", "idle");
  prefixTitle(true);
  if (fadeTimer) clearTimeout(fadeTimer);
  if (hideTimer) clearTimeout(hideTimer);
  fadeTimer = setTimeout(() => {
    pill.classList.add("idle");
    hideTimer = setTimeout(() => {
      pill.classList.add("hidden");
      prefixTitle(false);
    }, 4000);
  }, 8000);
}

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
  return title.replace(/^(🟢 \[Agent\] |● )/, "");
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
  document.head.appendChild(faviconLink);
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
