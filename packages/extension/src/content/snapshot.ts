/**
 * Content-script: snapshot engine.
 *
 * Builds a Playwright-style accessibility text tree of the page and assigns
 * stable refs (e1, e2, ...) to interactive + named elements. Refs live for
 * the current document only; any navigation invalidates them.
 */

import { PAGE_TEXT_MAX_CHARS, SNAPSHOT_MAX_NODES } from "@remora/protocol";
import { wireError } from "../shared.js";

export interface ResolvedTarget {
  el: Element;
  label: string;
}

const refMap = new Map<string, Element>();
let refCounter = 0;

export function resetRefs(): void {
  refMap.clear();
  refCounter = 0;
}

function mintRef(el: Element): string {
  refCounter += 1;
  const ref = `e${refCounter}`;
  refMap.set(ref, el);
  return ref;
}

export function getByRef(ref: string): Element {
  const el = refMap.get(ref);
  if (!el || !el.isConnected) {
    throw wireError("BAD_REF", `ref ${ref} is unknown or stale; take a new snapshot`);
  }
  return el;
}

/** Resolve a ref-or-selector target to a live element. */
export function resolveTarget(params: { ref?: string; selector?: string }): ResolvedTarget {
  if (params.ref) {
    const el = getByRef(params.ref);
    return { el, label: describe(el) };
  }
  if (params.selector) {
    const el = document.querySelector(params.selector);
    if (!el) throw wireError("NOT_FOUND", `no element matches selector: ${params.selector}`);
    return { el, label: describe(el) };
  }
  throw wireError("BAD_ARGS", "provide `ref` or `selector`");
}

/** Resolve an optional target (page-level actions accept neither). */
export function resolveOptionalTarget(params: { ref?: string; selector?: string }): ResolvedTarget | null {
  if (!params.ref && !params.selector) return null;
  return resolveTarget(params);
}

function describe(el: Element): string {
  const name = accessibleName(el).slice(0, 60);
  const tag = el.tagName.toLowerCase();
  return name ? `${tag} "${name}"` : tag;
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label?.textContent) return label.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap?.textContent) return wrap.textContent.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder;
    }
    if (el.name) return el.name;
  }
  if (el instanceof HTMLImageElement && el.alt) return el.alt;
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && (el as HTMLAnchorElement).href) return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type.toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button") return "button";
    if (t === "file") return "file";
    if (t === "hidden") return "hidden";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
  if (tag === "form") return "form";
  if (tag === "table") return "table";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  return "generic";
}

const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "file",
  "listitem",
]);

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.offsetParent === null && el.tagName !== "BODY" && el.tagName !== "HTML") {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

/**
 * Render the snapshot tree. Every interactive or named element gets a ref.
 * Returns Playwright-style text plus counts.
 */
export function buildSnapshot(compact = true): { text: string; truncated: boolean; nodeCount: number } {
  resetRefs();
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const visit = (el: Element, depth: number): void => {
    if (count >= SNAPSHOT_MAX_NODES) {
      truncated = true;
      return;
    }
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return;
    if (el.id === "remora-pill-root" || el.id === "remora-annotate-root") return;
    if (!isVisible(el)) return;

    const role = roleOf(el);
    const name = accessibleName(el);
    const interactive = INTERACTIVE.has(role);
    const named = name.length > 0;
    const show = interactive || named || role === "heading" || role === "form" || role === "table";

    if (compact && !show && (role === "generic" || role === "list")) {
      for (const child of el.children) {
        visit(child, depth);
        if (truncated) return;
      }
      return;
    }

    let ref = "";
    if (interactive || named) {
      ref = ` [ref=${mintRef(el)}]`;
      count += 1;
    }

    const indent = "  ".repeat(Math.min(depth, 12));
    const value = valueOf(el);
    lines.push(`${indent}- ${role}${name ? ` "${escapeQuotes(name)}"` : ""}${value}${ref}`);

    if (count >= SNAPSHOT_MAX_NODES) {
      truncated = true;
      return;
    }
    for (const child of el.children) {
      visit(child, depth + 1);
      if (truncated) return;
    }
  };

  visit(document.body ?? document.documentElement, 0);
  if (truncated) {
    lines.push(`... truncated at ${SNAPSHOT_MAX_NODES} nodes; refine with query or page_text`);
  }
  return { text: lines.join("\n"), truncated, nodeCount: count };
}

function valueOf(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? " [checked]" : "";
    if (el.type === "file") {
      return el.files?.length ? ` [${el.files.length} file(s)]` : "";
    }
    if (el.value && el.type !== "password") return ` [value="${escapeQuotes(el.value.slice(0, 60))}"]`;
    if (el.value) return " [value=••••]";
    return "";
  }
  if (el instanceof HTMLTextAreaElement && el.value) {
    return ` [value="${escapeQuotes(el.value.slice(0, 60))}"]`;
  }
  if (el instanceof HTMLSelectElement) {
    return ` [selected="${escapeQuotes(el.options[el.selectedIndex]?.text ?? "")}"]`;
  }
  if (el instanceof HTMLElement && el.isContentEditable && el.textContent) {
    return ` [value="${escapeQuotes(el.textContent.slice(0, 60))}"]`;
  }
  const disabled = (el as HTMLButtonElement).disabled;
  return disabled ? " [disabled]" : "";
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, "'");
}

/** All ref'd elements with viewport boxes (for annotated screenshots). */
export function annotatedElements(): Array<{ ref: string; role: string; name: string; box: { x: number; y: number; width: number; height: number } }> {
  const out: Array<{ ref: string; role: string; name: string; box: { x: number; y: number; width: number; height: number } }> = [];
  for (const [ref, el] of refMap) {
    if (!el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      continue;
    }
    out.push({
      ref,
      role: roleOf(el),
      name: accessibleName(el).slice(0, 40),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function pageText(maxChars = PAGE_TEXT_MAX_CHARS): { text: string; truncated: boolean } {
  const text = (document.body?.innerText ?? "").replace(/[ \t]+\n/g, "\n").trim();
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
