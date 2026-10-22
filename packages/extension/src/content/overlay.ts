/**
 * Content-script: agent-presence overlays.
 *
 * - Pill: floating status pill ("Remora · agent aktif" + last action),
 *   Shadow DOM isolated, pointer-events none, auto-fades after 8s idle.
 * - Highlight: 600ms outline pulse on the element being acted upon.
 * - Annotate: numbered badges over interactive elements for grounding.
 * - Title: `● ` prefix while the agent session is active.
 *
 * All layers are strictly informational (no buttons, no interception).
 */

import { annotatedElements } from "./snapshot.js";

const TEAL = "#0d9488";

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
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      background: rgba(11,28,26,.92); color: #eafffb;
      border: 1px solid rgba(13,148,136,.6); border-radius: 999px;
      padding: 8px 14px 8px 10px; pointer-events: none;
      font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 4px 18px rgba(0,0,0,.35);
      opacity: 1; transition: opacity .5s ease; max-width: min(420px, 60vw); }
    .pill.idle { opacity: .45; } .pill.hidden { opacity: 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: ${TEAL}; flex: none;
      box-shadow: 0 0 0 3px rgba(13,148,136,.25); }
    .dot.pulse { animation: rempulse 1.2s ease-in-out infinite; }
    @keyframes rempulse { 50% { box-shadow: 0 0 0 6px rgba(13,148,136,.12); } }
    .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .act { color: #7ff0e2; }
  `;
  pillBox = document.createElement("div");
  pillBox.className = "pill hidden";
  const dot = document.createElement("span");
  dot.className = "dot pulse";
  const txt = document.createElement("span");
  txt.className = "txt";
  const brand = document.createElement("strong");
  brand.textContent = "Remora · agent aktif";
  pillAction = document.createElement("span");
  pillAction.className = "act";
  pillTarget = document.createElement("span");
  txt.append(brand, pillAction, pillTarget);
  pillBox.append(dot, txt);
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

function prefixTitle(on: boolean): void {
  if (on) {
    if (originalTitle === null) originalTitle = document.title;
    if (!document.title.startsWith("● ")) document.title = `● ${document.title}`;
    if (!titleObserver) {
      titleObserver = new MutationObserver(() => {
        if (originalTitle !== null && !document.title.startsWith("● ")) {
          originalTitle = document.title;
          document.title = `● ${document.title}`;
        }
      });
      const titleEl = document.querySelector("title");
      if (titleEl) titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } else if (originalTitle !== null) {
    document.title = originalTitle;
    originalTitle = null;
    titleObserver?.disconnect();
    titleObserver = null;
  }
}

// ---------------------------------------------------------------------------
// highlight pulse
// ---------------------------------------------------------------------------

export function flashHighlight(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = `2px solid ${TEAL}`;
  el.style.outlineOffset = "2px";
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, 600);
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
