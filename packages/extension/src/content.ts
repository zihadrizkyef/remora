/**
 * Remora content script entry (ISOLATED world).
 * Receives { type: "remora:call", method, params } from background,
 * dispatches to snapshot/actions/uploads/overlay modules, and returns
 * the result (or a wire error object) synchronously via sendResponse.
 */

import {
  CONSOLE_MAX_ENTRIES,
  PAGE_HTML_MAX_CHARS,
  PAGE_TEXT_MAX_CHARS,
} from "@remora/protocol";
import { isWireError, wireError } from "./shared.js";
import {
  buildSnapshot,
  getByRef,
  pageText,
  resolveTarget,
} from "./content/snapshot.js";
import {
  doClick,
  doDrag,
  doFillForm,
  doFocus,
  doHover,
  doPressKey,
  doScroll,
  doSelectOption,
  doSetChecked,
  doType,
} from "./content/actions.js";
import {
  pasteTextFromClipboard,
  pasteTo,
  uploadAbort,
  uploadBegin,
  uploadChunk,
  uploadDrop,
  uploadInject,
} from "./content/uploads.js";
import {
  clearOrphanedMarkers,
  hideAnnotate,
  releaseIndicators,
  showActivity,
  showAnnotate,
  showTaskEnd,
  teardownOverlay,
} from "./content/overlay.js";
import type { TaskInfo, TaskOutcome } from "./content/overlay.js";
import { installCapture, readConsole, readErrors } from "./content/capture.js";

installCapture();

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

// Reloading the extension leaves the old content script running in open
// pages, cut off from the extension, and Remora then injects a new one. The
// newest instance announces itself on the shared DOM (works across isolated
// worlds); older ones retire so a page never shows two pills.
const TAKEOVER_EVENT = "remora:takeover";
document.dispatchEvent(new Event(TAKEOVER_EVENT));
clearOrphanedMarkers();
document.addEventListener(TAKEOVER_EVENT, retire);

function retire(): void {
  document.removeEventListener(TAKEOVER_EVENT, retire);
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    /* runtime already gone */
  }
  teardownOverlay();
}

chrome.runtime.onMessage.addListener(onMessage);

function onMessage(msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as {
    type?: string;
    method?: string;
    params?: P;
    action?: string;
    target?: string;
    task?: TaskInfo;
    outcome?: TaskOutcome;
    label?: string;
    steps?: number;
    durationMs?: number;
  };
  if (m.type === "remora:activity") {
    showActivity(m.action ?? "working", m.target, m.task);
    return false;
  }
  if (m.type === "remora:release") {
    releaseIndicators();
    return false;
  }
  if (m.type === "remora:task_end") {
    showTaskEnd(m.outcome ?? "done", m.label, m.steps ?? 0, m.durationMs ?? 0);
    return false;
  }
  if (m.type !== "remora:call" || !m.method) return false;
  void dispatch(m.method, m.params ?? {}).then(sendResponse, (err: unknown) => {
    if (isWireError(err)) sendResponse(err);
    else sendResponse(wireError("INTERNAL", err instanceof Error ? err.message : String(err)));
  });
  return true; // async response
}

async function dispatch(method: string, params: P): Promise<unknown> {
  switch (method) {
    // -- perception ---------------------------------------------------------
    case "snapshot": {
      const { text, truncated, nodeCount } = buildSnapshot(params.compact !== false);
      return {
        url: location.href,
        title: document.title,
        text,
        truncated,
        nodeCount,
      };
    }
    case "page.text": {
      const max = Math.min(num(params.maxChars) ?? PAGE_TEXT_MAX_CHARS, PAGE_TEXT_MAX_CHARS);
      return pageText(max);
    }
    case "page.html": {
      let root: Element = document.documentElement;
      if (params.ref || params.selector) {
        root = resolveTarget({ ref: str(params.ref), selector: str(params.selector) }).el;
      }
      const max = Math.min(num(params.maxChars) ?? PAGE_HTML_MAX_CHARS, PAGE_HTML_MAX_CHARS);
      const html = root.outerHTML;
      return { html: html.slice(0, max), truncated: html.length > max, length: html.length };
    }
    case "query": {
      const selector = str(params.selector) ?? "";
      const limit = Math.min(num(params.limit) ?? 20, 100);
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        throw wireError("BAD_ARGS", `invalid selector: ${selector}`);
      }
      const matches = [...nodes].slice(0, limit).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        id: el.id || undefined,
        class: typeof el.className === "string" ? el.className.slice(0, 80) || undefined : undefined,
        href: el.getAttribute("href") || undefined,
        type: el.getAttribute("type") || undefined,
        name: el.getAttribute("name") || undefined,
      }));
      return { count: nodes.length, matches };
    }
    case "page.info":
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        referrer: document.referrer,
      };
    case "console.logs":
      return {
        entries: readConsole(str(params.level) ?? "all", Math.min(num(params.limit) ?? 100, CONSOLE_MAX_ENTRIES)),
      };
    case "page.errors":
      return { entries: readErrors(Math.min(num(params.limit) ?? 50, 100)) };

    // -- annotate -------------------------------------------------------------
    case "annotate.show":
      return showAnnotate();
    case "annotate.hide":
      hideAnnotate();
      return { hidden: true };
    case "element.box": {
      const { el } = resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    case "screenshot.fullPage":
      return { supported: false };

    // -- history fallback -------------------------------------------------------
    case "nav.back":
      history.back();
      return { ok: true };
    case "nav.forward":
      history.forward();
      return { ok: true };

    // -- interaction --------------------------------------------------------------
    case "click":
      return doClick(params);
    case "hover":
      return doHover(params);
    case "type":
      return doType(params);
    case "form.fill":
      return doFillForm(params);
    case "select.option":
      return doSelectOption(params);
    case "set.checked":
      return doSetChecked(params);
    case "scroll":
      return doScroll(params);
    case "drag":
      return doDrag(params);
    case "press.key":
      return doPressKey(params);
    case "focus":
      return doFocus(params);

    // -- clipboard ------------------------------------------------------------------
    case "clipboard.read": {
      try {
        return { text: await navigator.clipboard.readText() };
      } catch {
        throw wireError("NOT_ALLOWED", "clipboard read denied; the page must have focus and clipboard permission");
      }
    }
    case "clipboard.write": {
      try {
        await navigator.clipboard.writeText(str(params.text) ?? "");
        return { ok: true };
      } catch {
        throw wireError("NOT_ALLOWED", "clipboard write denied; the page must have focus");
      }
    }
    case "clipboard.copyFrom": {
      const { el } = resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
      const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value
        : el.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        throw wireError("NOT_ALLOWED", "clipboard write denied; the page must have focus");
      }
      return { copied: text.length };
    }
    case "clipboard.pasteTo":
      if (params.base64) return pasteTo(params);
      return pasteTextFromClipboard(params);

    // -- waiting ----------------------------------------------------------------------
    case "wait.for":
      return waitFor(params);

    // -- JS (gated in background) ---------------------------------------------------------
    case "evaluate":
      return evaluateJs(params);

    // -- storage ----------------------------------------------------------------------------
    case "storage.get": {
      const area = str(params.area) === "session" ? sessionStorage : localStorage;
      const keys = params.keys as string[] | undefined;
      if (keys) {
        const out: Record<string, string | null> = {};
        for (const k of keys) out[k] = area.getItem(k);
        return { entries: out };
      }
      const out: Record<string, string> = {};
      for (let i = 0; i < area.length; i++) {
        const k = area.key(i);
        if (k) out[k] = area.getItem(k) ?? "";
      }
      return { entries: out };
    }
    case "storage.set": {
      const area = str(params.area) === "session" ? sessionStorage : localStorage;
      const entries = (params.entries as Record<string, string>) ?? {};
      for (const [k, v] of Object.entries(entries)) area.setItem(k, v);
      for (const k of ((params.remove as string[]) ?? [])) area.removeItem(k);
      return { ok: true };
    }

    // -- uploads ----------------------------------------------------------------------------------
    case "upload.begin":
      return uploadBegin(params);
    case "upload.chunk":
      return uploadChunk(params);
    case "upload.inject":
      return uploadInject(params);
    case "upload.drop":
      return uploadDrop(params);
    case "upload.abort":
      return uploadAbort(params);

    default:
      throw wireError("UNKNOWN_METHOD", `content: not implemented: ${method}`);
  }
}

async function waitFor(params: P): Promise<{ matched: string }> {
  const timeoutMs = Math.min(num(params.timeoutMs) ?? 30_000, 120_000);
  const selector = str(params.selector);
  const text = str(params.text);
  const wantNav = params.navigation === true;
  const startUrl = location.href;

  if (!selector && !text && !wantNav) {
    throw wireError("BAD_ARGS", "wait_for needs `selector`, `text`, or `navigation: true`");
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (wantNav && location.href !== startUrl) return { matched: "navigation" };
    if (selector) {
      try {
        if (document.querySelector(selector)) return { matched: `selector: ${selector}` };
      } catch {
        throw wireError("BAD_ARGS", `invalid selector: ${selector}`);
      }
    }
    if (text && (document.body?.innerText ?? "").includes(text)) {
      return { matched: `text: ${text.slice(0, 60)}` };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw wireError("TIMEOUT", `wait_for timed out after ${timeoutMs}ms`);
}

/**
 * JS evaluation runs in the ISOLATED world (sees the DOM, not page JS
 * variables). This is a deliberate sandbox: full MAIN-world access would
 * need scripting.executeScript, which we keep off by default.
 */
async function evaluateJs(params: P): Promise<{ value: unknown; type: string }> {
  const expression = str(params.expression) ?? "";
  const timeoutMs = Math.min(num(params.timeoutMs) ?? 10_000, 30_000);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction(`return (${expression});`);
  } catch {
    fn = new AsyncFunction(expression);
  }
  const value = await Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timed out")), timeoutMs)),
  ]);
  let json: unknown = null;
  try {
    json = JSON.parse(JSON.stringify(value) ?? "null");
  } catch {
    json = String(value);
  }
  return { value: json, type: typeof value };
}

void getByRef;

// Each page load gets a fresh content script; ask the background whether the
// agent touched this tab moments ago so the pill survives agent navigation.
void chrome.runtime
  .sendMessage({ type: "remora:ready" })
  .then((resp: { active?: boolean; action?: string; target?: string; task?: TaskInfo } | undefined) => {
    if (resp?.active) showActivity(resp.action ?? "working", resp.target, resp.task);
  })
  .catch(() => undefined);
