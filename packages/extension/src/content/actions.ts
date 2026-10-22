/**
 * Content-script: synthetic user actions.
 *
 * All gestures are trusted-enough synthesized events (no chrome.debugger,
 * so no "controlled" banner). Works on plain DOM and React/Vue apps via
 * the native value setter trick.
 */

import { wireError } from "../shared.js";
import { getByRef, resolveOptionalTarget, resolveTarget } from "./snapshot.js";
import { flashHighlight } from "./overlay.js";

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function targetOf(params: P): { el: Element; label: string } {
  return resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
}

function scrollIntoViewIfNeeded(el: Element): void {
  const rect = el.getBoundingClientRect();
  const visible =
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  if (!visible) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function centerOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function mouseEvent(type: string, x: number, y: number, button = 0): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button,
    buttons: type === "mousemove" || type === "mousedown" ? 1 : 0,
  });
}

/** Native setter trick so React/Vue observes programmatic value changes. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function focusable(el: Element): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  return el.parentElement;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export function doClick(params: P): { clicked: string } {
  const { el, label } = targetOf(params);
  if (el instanceof HTMLElement && el.tagName !== "BODY") scrollIntoViewIfNeeded(el);
  const { x, y } = centerOf(el);
  const button = str(params.button) ?? "left";
  const btn = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const count = Math.min(3, Math.max(1, num(params.clickCount) ?? 1));
  for (let i = 0; i < count; i++) {
    el.dispatchEvent(mouseEvent("mousemove", x, y));
    el.dispatchEvent(mouseEvent("mousedown", x, y, btn));
    focusable(el)?.focus({ preventScroll: true });
    el.dispatchEvent(mouseEvent("mouseup", x, y, btn));
    el.dispatchEvent(mouseEvent("click", x, y, btn));
  }
  if (button === "right") {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }
  flashHighlight(el);
  return { clicked: label };
}

export function doHover(params: P): { hovered: string } {
  const { el, label } = targetOf(params);
  const { x, y } = centerOf(el);
  el.dispatchEvent(mouseEvent("mousemove", x, y));
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: x, clientY: y }));
  flashHighlight(el);
  return { hovered: label };
}

export function doType(params: P): { typed: string; chars: number } {
  const { el, label } = targetOf(params);
  const text = str(params.text) ?? "";
  const target = focusable(el);
  if (!target) throw wireError("NOT_FOUND", "element is not focusable");
  target.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (params.clearFirst !== false) setNativeValue(el, "");
    setNativeValue(el, (params.clearFirst === false ? el.value : "") + text);
  } else if (target.isContentEditable) {
    if (params.clearFirst !== false) target.textContent = "";
    target.textContent = (target.textContent ?? "") + text;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  } else {
    throw wireError("NOT_FOUND", "element is not editable; target an input, textarea, or contenteditable");
  }
  if (params.submit === true) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    el.closest("form")?.requestSubmit();
  }
  flashHighlight(el);
  return { typed: label, chars: text.length };
}

export function doFillForm(params: P): { filled: number; submitted: boolean } {
  const fields = params.fields as Array<{ ref?: string; selector?: string; name?: string; value: string }>;
  let filled = 0;
  let form: HTMLFormElement | null = null;
  for (const f of fields) {
    let el: Element | null = null;
    if (f.ref) el = getByRef(f.ref);
    else if (f.selector) el = document.querySelector(f.selector);
    else if (f.name) el = findByName(f.name);
    if (!el) throw wireError("NOT_FOUND", `form field not found: ${f.ref ?? f.selector ?? f.name}`);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        el.checked = f.value === "true" || f.value === "1" || f.value === "on";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        setNativeValue(el, f.value);
      }
    } else if (el instanceof HTMLSelectElement) {
      selectValues(el, [f.value]);
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      el.textContent = f.value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      throw wireError("NOT_FOUND", "field is not fillable");
    }
    form = form ?? el.closest("form");
    filled++;
    flashHighlight(el);
  }
  let submitted = false;
  if (params.submit === true && form) {
    form.requestSubmit();
    submitted = true;
  }
  return { filled, submitted };
}

function findByName(name: string): Element | null {
  const lower = name.toLowerCase();
  const candidates = document.querySelectorAll("input, textarea, select, [contenteditable='true']");
  for (const el of candidates) {
    const attrs = [
      el.getAttribute("name"),
      el.id,
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
    ].filter(Boolean) as string[];
    if (attrs.some((a) => a.toLowerCase().includes(lower))) return el;
    const labelled = el.closest("label")?.textContent?.toLowerCase() ?? "";
    if (labelled.includes(lower)) return el;
  }
  return null;
}

export function doSelectOption(params: P): { selected: string[] } {
  const { el } = targetOf(params);
  if (!(el instanceof HTMLSelectElement)) {
    throw wireError("NOT_FOUND", "target is not a <select>");
  }
  const values = params.values as string[];
  selectValues(el, values);
  flashHighlight(el);
  return { selected: [...el.selectedOptions].map((o) => o.value || o.text) };
}

function selectValues(el: HTMLSelectElement, values: string[]): void {
  const wanted = values.map((v) => v.toLowerCase());
  let matched = 0;
  for (const opt of el.options) {
    const hit = wanted.includes(opt.value.toLowerCase()) || wanted.includes(opt.text.toLowerCase());
    if (el.multiple) {
      opt.selected = hit;
      if (hit) matched++;
    } else if (hit) {
      el.value = opt.value;
      matched++;
      break;
    }
  }
  if (!matched) throw wireError("NOT_FOUND", `no option matches: ${values.join(", ")}`);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function doSetChecked(params: P): { checked: boolean } {
  const { el } = targetOf(params);
  if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) {
    throw wireError("NOT_FOUND", "target is not a checkbox or radio");
  }
  el.checked = params.checked === true;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flashHighlight(el);
  return { checked: el.checked };
}

export function doScroll(params: P): { scrolled: string } {
  const target = resolveOptionalTarget({ ref: str(params.ref), selector: str(params.selector) });
  if (params.intoView === true && target) {
    target.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    return { scrolled: `into view: ${target.label}` };
  }
  const direction = str(params.direction) ?? "down";
  const pixels = num(params.pixels) ?? Math.round(window.innerHeight * 0.8);
  const dx = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
  const dy = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
  if (direction === "top" || direction === "bottom") {
    const host: Element | Window = target ? target.el : document.scrollingElement ?? document.documentElement;
    const top = direction === "top" ? 0 : 999_999_999;
    if (host instanceof Window) host.scrollTo({ top });
    else host.scrollTop = top;
    return { scrolled: direction };
  }
  if (target) {
    target.el.scrollBy({ left: dx, top: dy });
  } else {
    window.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
  }
  return { scrolled: direction };
}

export function doDrag(params: P): { dragged: boolean } {
  const from = resolveTarget({ ref: str(params.fromRef), selector: str(params.fromSelector) });
  let toX = num(params.toX);
  let toY = num(params.toY);
  if (toX === undefined || toY === undefined) {
    const to = resolveTarget({ ref: str(params.toRef), selector: str(params.toSelector) });
    const c = centerOf(to.el);
    toX = c.x;
    toY = c.y;
  }
  const a = centerOf(from.el);
  from.el.dispatchEvent(mouseEvent("mousemove", a.x, a.y));
  from.el.dispatchEvent(mouseEvent("mousedown", a.x, a.y));
  document.elementFromPoint(toX, toY)?.dispatchEvent(mouseEvent("mousemove", toX, toY));
  document.elementFromPoint(toX, toY)?.dispatchEvent(mouseEvent("mouseup", toX, toY));
  flashHighlight(from.el);
  return { dragged: true };
}

const KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  space: " ",
  spacebar: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  delete: "Delete",
  del: "Delete",
  backspace: "Backspace",
};

export function doPressKey(params: P): { pressed: string } {
  const raw = str(params.key) ?? "";
  const target = resolveOptionalTarget({ ref: str(params.ref), selector: str(params.selector) });
  const host = (target ? focusable(target.el) : document.activeElement instanceof HTMLElement ? document.activeElement : document.body) ?? document.body;
  host.focus({ preventScroll: true });
  const parts = raw.split("+").map((p) => p.trim());
  const keyName = parts[parts.length - 1].toLowerCase();
  const key = KEY_ALIASES[keyName] ?? parts[parts.length - 1];
  const init: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: parts.some((p) => /^ctrl(ol)?$/i.test(p)),
    altKey: parts.some((p) => /^alt$/i.test(p)),
    shiftKey: parts.some((p) => /^shift$/i.test(p)),
    metaKey: parts.some((p) => /^(meta|cmd|command|win)$/i.test(p)),
  };
  host.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key.length === 1 && !init.ctrlKey && !init.metaKey) {
    host.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: key }));
  }
  host.dispatchEvent(new KeyboardEvent("keyup", init));
  return { pressed: raw };
}

export function doFocus(params: P): { focused: string } {
  const { el, label } = targetOf(params);
  focusable(el)?.focus({ preventScroll: false });
  flashHighlight(el);
  return { focused: label };
}
