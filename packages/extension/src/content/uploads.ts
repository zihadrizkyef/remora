/**
 * Content-script: file upload pipeline (Explorer-dialog bypass).
 *
 * The MCP server streams file bytes as base64 chunks; this module stages
 * them per transferId, reassembles a File, and either injects it into an
 * <input type=file> (upload.inject) or drops it on a zone (upload.drop).
 * The native file chooser is never opened — the agent never clicks the
 * button, so Windows Explorer never appears.
 */

import { wireError } from "../shared.js";
import { resolveTarget } from "./snapshot.js";
import { flashHighlight } from "./overlay.js";

interface StagedTransfer {
  fileName: string;
  mimeType: string;
  totalBytes: number;
  chunks: string[];
  received: number;
}

const staged = new Map<string, StagedTransfer>();

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function uploadBegin(params: P): { transferId: string } {
  const transferId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const chunks = num(params.chunks) ?? 1;
  staged.set(transferId, {
    fileName: str(params.fileName) ?? "file",
    mimeType: str(params.mimeType) ?? "application/octet-stream",
    totalBytes: num(params.totalBytes) ?? 0,
    chunks: new Array(chunks).fill(""),
    received: 0,
  });
  return { transferId };
}

export function uploadChunk(params: P): { received: number } {
  const t = staged.get(str(params.transferId) ?? "");
  if (!t) throw wireError("UPLOAD_ABORTED", "unknown transferId");
  const index = num(params.index) ?? 0;
  if (index < 0 || index >= t.chunks.length) {
    throw wireError("BAD_ARGS", `chunk index ${index} out of range`);
  }
  if (!t.chunks[index]) t.received++;
  t.chunks[index] = str(params.base64) ?? "";
  return { received: t.received };
}

export function uploadAbort(params: P): { aborted: boolean } {
  return { aborted: staged.delete(str(params.transferId) ?? "") };
}

function takeFile(transferId: string): File {
  const t = staged.get(transferId);
  if (!t) throw wireError("UPLOAD_ABORTED", "unknown transferId");
  if (t.received < t.chunks.length) {
    throw wireError("UPLOAD_ABORTED", `incomplete transfer (${t.received}/${t.chunks.length} chunks)`);
  }
  staged.delete(transferId);
  const parts = t.chunks.map((c) => base64ToBytes(c));
  return new File(parts, t.fileName, { type: t.mimeType });
}

function findFileInput(target: { ref?: string; selector?: string }): HTMLInputElement {
  if (target.ref || target.selector) {
    const { el } = resolveTarget(target);
    const input = el instanceof HTMLInputElement && el.type === "file"
      ? el
      : el.querySelector?.('input[type="file"]');
    if (input instanceof HTMLInputElement) return input;
    throw wireError("NOT_FOUND", "target is not a file input and contains none");
  }
  const first = document.querySelector('input[type="file"]');
  if (first instanceof HTMLInputElement) return first;
  throw wireError("NOT_FOUND", "no file input on this page; provide ref or selector");
}

export function uploadInject(params: P): { injected: string; files: number } {
  const file = takeFile(str(params.transferId) ?? "");
  const input = findFileInput({ ref: str(params.ref), selector: str(params.selector) });

  // Temporarily reveal hidden inputs (display:none still accepts .files set).
  const dt = new DataTransfer();
  // Preserve already-selected files when input allows multiple.
  if (input.multiple && input.files) {
    for (const f of input.files) dt.items.add(f);
  }
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flashHighlight(input);
  return { injected: file.name, files: dt.files.length };
}

export function uploadDrop(params: P): { dropped: string } {
  const file = takeFile(str(params.transferId) ?? "");
  const { el, label } = resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
  const dt = new DataTransfer();
  dt.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"] as const) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }
  el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }));
  flashHighlight(el);
  void label;
  return { dropped: file.name };
}

/** Synthetic paste of clipboard text or an injected file. */
export function pasteTo(params: P): { pasted: string } {
  const { el, label } = resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
  const host = el instanceof HTMLElement ? el : el.parentElement;
  if (!host) throw wireError("NOT_FOUND", "paste target is not an element");
  host.focus({ preventScroll: true });

  if (params.base64 && typeof params.base64 === "string") {
    const file = new File(
      [base64ToBytes(params.base64)],
      str(params.fileName) ?? "pasted-file",
      { type: str(params.mimeType) ?? "application/octet-stream" },
    );
    const dt = new DataTransfer();
    dt.items.add(file);
    host.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    flashHighlight(el);
    return { pasted: `file ${file.name}` };
  }

  // Text paste: read OS clipboard then insert (clipboard-read needs focus).
  return { pasted: label };
}

export async function pasteTextFromClipboard(params: P): Promise<{ pasted: string; chars: number }> {
  const { el } = resolveTarget({ ref: str(params.ref), selector: str(params.selector) });
  const host = el instanceof HTMLElement ? el : el.parentElement;
  if (!host) throw wireError("NOT_FOUND", "paste target is not an element");
  host.focus({ preventScroll: true });
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    throw wireError("NOT_ALLOWED", "clipboard read denied; the page must have focus and clipboard permission");
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (host.isContentEditable) {
    host.textContent = (host.textContent ?? "") + text;
    host.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  } else {
    throw wireError("NOT_FOUND", "paste target is not editable");
  }
  flashHighlight(el);
  return { pasted: "clipboard text", chars: text.length };
}
