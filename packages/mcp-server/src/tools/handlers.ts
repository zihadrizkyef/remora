import {
  AgentActivityPayload,
  TabInfo,
  WireError,
  WireMethodName,
} from "@remora/protocol";
import type { RemoraHub } from "../hub.js";
import { listActive, summarize } from "../activity.js";
import { prepareFile, toolError, transferFile } from "../uploads.js";

/**
 * Tool implementations. Each handler receives validated args and returns a
 * JSON-serializable result. Handlers that touch a tab also emit
 * `activity.show` so the extension renders the in-page pill.
 */

export type Ctx = { hub: RemoraHub };

function isWireError(err: unknown): err is WireError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/** Map wire errors to agent-friendly messages. */
export function toAgentError(err: unknown): Error {
  if (isWireError(err)) {
    switch (err.code) {
      case "NO_EXTENSION":
        return toolError(
          "Remora extension is not connected. Ask the user to open Chrome with the Remora extension installed, paired, and enabled.",
        );
      case "NO_CONTENT_SCRIPT":
        return toolError(
          "This page cannot be automated (browser-internal page such as chrome://, Chrome Web Store, or a PDF viewer). Navigate to a regular web page first.",
        );
      case "BAD_REF":
        return toolError(
          "Element ref is unknown or stale. Call `snapshot` again to get fresh refs, then retry.",
        );
      case "NAVIGATED":
        return toolError("The page navigated mid-action. Call `snapshot` again, then retry.");
      case "NOT_ALLOWED":
        return toolError(`Not allowed: ${err.message}. Check the Remora popup toggles.`);
      case "SITE_BLOCKED":
        return toolError("This site is blocked by the user's per-site kill-switch. Stop and tell the user.");
      case "TAB_CLAIMED":
        return toolError(
          `${err.message} Call tabs_list to see claimed tabs, then tab_create to work in your own tab.`,
        );
      case "NO_TAB":
        return toolError("Tab not found (it may have been closed). Call `tabs_list` for current tabs.");
      default:
        return toolError(`${err.code}: ${err.message}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function call<T>(
  ctx: Ctx,
  method: WireMethodName,
  params?: unknown,
  timeoutMs?: number,
): Promise<T> {
  try {
    return await ctx.hub.request<T>(method, params, timeoutMs);
  } catch (err) {
    throw toAgentError(err);
  }
}

function touched(ctx: Ctx, tabId: number | undefined, activity: string, target?: string): void {
  if (tabId === undefined) return;
  ctx.hub.showActivity(tabId, activity, target);
}

/**
 * Guard a mutating tool against another session's claim. Throws a
 * TAB_CLAIMED tool error naming the owner. Returns the resolved tabId for
 * activity reporting (may be undefined when the tab is implicit and the
 * active tab could not be determined — the extension call then fails as
 * before).
 */
async function guard(ctx: Ctx, tabId?: number): Promise<number | undefined> {
  try {
    return await ctx.hub.guardTab(tabId);
  } catch (err) {
    throw toAgentError(err);
  }
}

/** Attach `claimedBy` info to tab rows so agents can avoid owned tabs. */
function withClaims(ctx: Ctx, tabs: unknown): unknown {
  if (!Array.isArray(tabs)) return tabs;
  const byId = new Map(ctx.hub.listClaims().map((c) => [c.tabId, c]));
  if (byId.size === 0) return tabs;
  return tabs.map((t) => {
    if (typeof t !== "object" || t === null || typeof (t as { id?: unknown }).id !== "number") return t;
    const claim = byId.get((t as { id: number }).id);
    if (!claim) return t;
    return {
      ...(t as Record<string, unknown>),
      claimedBy: claim.ownerLabel ?? claim.agentId,
      ...(claim.note ? { claimNote: claim.note } : {}),
      claimedByMe: claim.agentId === ctx.hub.agentId,
    };
  });
}

/** Resolve "active tab" early so activity is attributed even when tabId is omitted. */
async function resolveTabId(ctx: Ctx, tabId?: number): Promise<number | undefined> {
  if (tabId !== undefined) return tabId;
  try {
    const tabs = await ctx.hub.request<TabInfo[]>("tabs.list", {});
    return tabs.find((t) => t.active)?.id;
  } catch {
    return undefined;
  }
}

// -- connection ---------------------------------------------------------------

export async function remora_status(ctx: Ctx): Promise<unknown> {
  const active: AgentActivityPayload[] = listActive().map((a) => ({
    tabId: a.tabId,
    action: a.action,
    target: a.target,
    ts: a.ts,
  }));
  // Every MCP session shares one hub; `hubRole` tells a user whether this
  // process owns the port or is forwarding to the session that does.
  const hubRole = ctx.hub.isPrimary ? "primary" : "attached";
  if (!ctx.hub.connected) {
    return {
      connected: false,
      hubRole,
      hint: "Extension not connected. Ask the user to open Chrome with Remora installed and paired.",
      activeTabs: active,
      claims: ctx.hub.listClaims(),
    };
  }
  const ext = ctx.hub.extension;
  return {
    connected: true,
    hubRole,
    extensionVersion: ext?.version ?? "unknown",
    protocol: ext?.protocol ?? 1,
    tabCount: ext?.tabCount ?? 0,
    activeTabs: active,
    claims: ctx.hub.listClaims(),
    agentId: ctx.hub.agentId,
  };
}

// -- tabs & windows -------------------------------------------------------------

export async function tabs_list(ctx: Ctx): Promise<unknown> {
  const tabs = await call(ctx, "tabs.list", {});
  // Drop claims for tabs that no longer exist; primary then broadcasts the trim.
  if (Array.isArray(tabs) && ctx.hub.isPrimary) {
    const ids = new Set<number>();
    for (const t of tabs) {
      if (typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "number") {
        ids.add((t as { id: number }).id);
      }
    }
    ctx.hub.pruneClaims(ids);
  }
  return withClaims(ctx, tabs);
}

export async function tab_activate(ctx: Ctx, args: { tabId: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.activate", args);
  touched(ctx, args.tabId, "activated tab");
  return r;
}

export async function tab_create(ctx: Ctx, args: { url?: string; active?: boolean }): Promise<unknown> {
  const tab = await call<TabInfo>(ctx, "tabs.create", args);
  // Own new tabs immediately so a second session never grabs them. Best
  // effort: creation itself already succeeded.
  await ctx.hub.claimTab(tab.id).catch(() => undefined);
  touched(ctx, tab.id, "opened tab", tab.url || tab.title);
  return withClaims(ctx, [tab]);
}

export async function tab_claim(ctx: Ctx, args: { tabId?: number; note?: string }): Promise<unknown> {
  const id = await resolveTabId(ctx, args.tabId);
  if (id === undefined) {
    throw toolError("No tab to claim. Call tabs_list for current tabs, or tab_create for a fresh tab.");
  }
  try {
    const claim = await ctx.hub.claimTab(id, args.note);
    touched(ctx, id, "claimed tab", args.note);
    return claim;
  } catch (err) {
    throw toAgentError(err);
  }
}

export async function tab_release(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await resolveTabId(ctx, args.tabId);
  if (id === undefined) {
    throw toolError("No tab to release. Call tabs_list for current tabs.");
  }
  try {
    const released = await ctx.hub.releaseTab(id);
    return { released, tabId: id };
  } catch (err) {
    throw toAgentError(err);
  }
}

export async function tab_close(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const id = await resolveTabId(ctx, args.tabId);
  const r = await call(ctx, "tabs.close", { tabId: args.tabId });
  if (id !== undefined) touched(ctx, id, "closed tab");
  return r;
}

export async function tab_duplicate(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const tab = await call<TabInfo>(ctx, "tabs.duplicate", { tabId: args.tabId });
  // A duplicate is a fresh tab for this session — own it like tab_create.
  await ctx.hub.claimTab(tab.id).catch(() => undefined);
  touched(ctx, tab.id, "duplicated tab", tab.title);
  return tab;
}

export async function tab_pin(ctx: Ctx, args: { tabId?: number; pinned: boolean }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.pin", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), args.pinned ? "pinned tab" : "unpinned tab");
  return r;
}

export async function tab_mute(ctx: Ctx, args: { tabId?: number; muted: boolean }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.mute", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), args.muted ? "muted tab" : "unmuted tab");
  return r;
}

export async function tab_move(
  ctx: Ctx,
  args: { tabId?: number; index: number; windowId?: number },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.move", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "moved tab");
  return r;
}

export async function windows_list(ctx: Ctx): Promise<unknown> {
  return call(ctx, "windows.list", {});
}

// -- navigation -------------------------------------------------------------------

export async function navigate(ctx: Ctx, args: { tabId?: number; url: string }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "navigate", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "navigated", args.url);
  return r;
}

export async function go_back(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.back", { tabId: args.tabId });
  touched(ctx, await resolveTabId(ctx, args.tabId), "went back");
  return r;
}

export async function go_forward(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.forward", { tabId: args.tabId });
  touched(ctx, await resolveTabId(ctx, args.tabId), "went forward");
  return r;
}

export async function reload(ctx: Ctx, args: { tabId?: number; hard?: boolean }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.reload", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "reloaded");
  return r;
}

// -- perception ---------------------------------------------------------------------

export async function snapshot(ctx: Ctx, args: { tabId?: number; compact?: boolean }): Promise<unknown> {
  const r = await call(ctx, "snapshot", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "read page");
  return r;
}

export async function page_text(ctx: Ctx, args: { tabId?: number; maxChars?: number }): Promise<unknown> {
  const r = await call(ctx, "page.text", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "read text");
  return r;
}

export async function page_html(
  ctx: Ctx,
  args: { tabId?: number; ref?: string; selector?: string; maxChars?: number },
): Promise<unknown> {
  const r = await call(ctx, "page.html", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "read HTML");
  return r;
}

export async function query(
  ctx: Ctx,
  args: { tabId?: number; selector: string; limit?: number },
): Promise<unknown> {
  const r = await call(ctx, "query", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "queried page", args.selector);
  return r;
}

export async function page_info(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  return call(ctx, "page.info", { tabId: args.tabId });
}

export async function console_logs(
  ctx: Ctx,
  args: { tabId?: number; level?: string; limit?: number },
): Promise<unknown> {
  return call(ctx, "console.logs", args);
}

export async function page_errors(ctx: Ctx, args: { tabId?: number; limit?: number }): Promise<unknown> {
  return call(ctx, "page.errors", args);
}

// -- visual ---------------------------------------------------------------------------

export async function screenshot(
  ctx: Ctx,
  args: {
    tabId?: number;
    mode?: "viewport" | "fullPage" | "selector" | "ref";
    ref?: string;
    selector?: string;
    format?: "png" | "jpeg";
    quality?: number;
  },
): Promise<unknown> {
  const r = await call(ctx, "screenshot", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "took screenshot");
  return r;
}

export async function screenshot_annotated(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const id = await resolveTabId(ctx, args.tabId);
  await call(ctx, "annotate.show", { tabId: args.tabId });
  try {
    const shot = await call(ctx, "screenshot", { tabId: args.tabId, mode: "viewport" });
    touched(ctx, id, "took annotated screenshot");
    return shot;
  } finally {
    await call(ctx, "annotate.hide", { tabId: args.tabId }).catch(() => undefined);
  }
}

export async function export_pdf(
  ctx: Ctx,
  args: { tabId?: number; landscape?: boolean },
): Promise<unknown> {
  const r = await call(ctx, "export.pdf", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "exported PDF");
  return r;
}

// -- interaction --------------------------------------------------------------------------

type TargetArgs = { tabId?: number; ref?: string; selector?: string };
const labelOf = (a: TargetArgs) => a.ref ?? a.selector;

export async function click(
  ctx: Ctx,
  args: TargetArgs & { button?: "left" | "middle" | "right"; clickCount?: number },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "click", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "clicked", summarize("element", labelOf(args)));
  return r;
}

export async function hover(ctx: Ctx, args: TargetArgs): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "hover", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "hovered", labelOf(args));
  return r;
}

export async function type(
  ctx: Ctx,
  args: TargetArgs & { text: string; submit?: boolean; clearFirst?: boolean },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "type", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "typed", `into ${labelOf(args) ?? "field"}`);
  return r;
}

export async function fill_form(
  ctx: Ctx,
  args: {
    tabId?: number;
    fields: Array<{ ref?: string; selector?: string; name?: string; value: string }>;
    submit?: boolean;
  },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "form.fill", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "filled form", `${args.fields.length} fields`);
  return r;
}

export async function select_option(
  ctx: Ctx,
  args: TargetArgs & { values: string[] },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "select.option", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "selected option", args.values.join(", "));
  return r;
}

export async function set_checked(ctx: Ctx, args: TargetArgs & { checked: boolean }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "set.checked", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), args.checked ? "checked" : "unchecked", labelOf(args));
  return r;
}

export async function scroll(
  ctx: Ctx,
  args: TargetArgs & {
    direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
    pixels?: number;
    intoView?: boolean;
  },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "scroll", args);
  const what = args.intoView ? `to ${labelOf(args)}` : (args.direction ?? "page");
  touched(ctx, await resolveTabId(ctx, args.tabId), "scrolled", what);
  return r;
}

export async function drag(
  ctx: Ctx,
  args: {
    tabId?: number;
    fromRef?: string;
    fromSelector?: string;
    toRef?: string;
    toSelector?: string;
    toX?: number;
    toY?: number;
  },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "drag", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "dragged");
  return r;
}

export async function press_key(ctx: Ctx, args: TargetArgs & { key: string }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "press.key", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "pressed key", args.key);
  return r;
}

export async function focus(ctx: Ctx, args: TargetArgs): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "focus", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "focused", labelOf(args));
  return r;
}

// -- clipboard ------------------------------------------------------------------------------

export async function clipboard_read(ctx: Ctx): Promise<unknown> {
  return call(ctx, "clipboard.read", {});
}

export async function clipboard_write(ctx: Ctx, args: { text: string }): Promise<unknown> {
  const r = await call(ctx, "clipboard.write", args);
  return { ok: true, chars: args.text.length, ...((r as object) ?? {}) };
}

export async function clipboard_copy_from(ctx: Ctx, args: TargetArgs): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "clipboard.copyFrom", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "copied", labelOf(args));
  return r;
}

export async function clipboard_paste_to(
  ctx: Ctx,
  args: TargetArgs & { filePath?: string },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  if (args.filePath) {
    const file = await prepareFile(args.filePath);
    const id = await resolveTabId(ctx, args.tabId);
    const base64 = file.data.toString("base64");
    const r = await call(ctx, "clipboard.pasteTo", {
      tabId: args.tabId,
      ref: args.ref,
      selector: args.selector,
      filePath: args.filePath,
      fileName: file.fileName,
      mimeType: file.mimeType,
      base64,
    });
    touched(ctx, id, "pasted file", file.fileName);
    return r;
  }
  const r = await call(ctx, "clipboard.pasteTo", {
    tabId: args.tabId,
    ref: args.ref,
    selector: args.selector,
  });
  touched(ctx, await resolveTabId(ctx, args.tabId), "pasted", labelOf(args));
  return r;
}

// -- waiting ------------------------------------------------------------------------------------

export async function wait_for(
  ctx: Ctx,
  args: { tabId?: number; selector?: string; text?: string; navigation?: boolean; timeoutMs?: number },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "wait.for", args, Math.min((args.timeoutMs ?? 30_000) + 5_000, 130_000));
  touched(
    ctx,
    await resolveTabId(ctx, args.tabId),
    "waited",
    args.selector ?? (args.text ? `text "${args.text.slice(0, 40)}"` : args.navigation ? "navigation" : undefined),
  );
  return r;
}

export async function sleep(_ctx: Ctx, args: { ms: number }): Promise<unknown> {
  await new Promise((r) => setTimeout(r, args.ms));
  return { sleptMs: args.ms };
}

// -- JS & storage -----------------------------------------------------------------------------------

export async function evaluate_js(
  ctx: Ctx,
  args: { tabId?: number; expression: string; timeoutMs?: number },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "evaluate", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "ran script");
  return r;
}

export async function cookies_list(ctx: Ctx, args: { url?: string }): Promise<unknown> {
  return call(ctx, "cookies.list", args);
}

export async function cookies_set(
  ctx: Ctx,
  args: { url: string; name: string; value: string; expirationDate?: number },
): Promise<unknown> {
  return call(ctx, "cookies.set", args);
}

export async function cookies_clear(ctx: Ctx, args: { url?: string }): Promise<unknown> {
  return call(ctx, "cookies.clear", args);
}

export async function storage_get(
  ctx: Ctx,
  args: { tabId?: number; area: "local" | "session"; keys?: string[] },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "storage.get", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), `read ${args.area}Storage`);
  return r;
}

export async function storage_set(
  ctx: Ctx,
  args: { tabId?: number; area: "local" | "session"; entries?: Record<string, string>; remove?: string[] },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  if (!args.entries && !args.remove) throw toolError("Provide `entries` and/or `remove`.");
  const r = await call(ctx, "storage.set", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), `wrote ${args.area}Storage`);
  return r;
}

// -- network ------------------------------------------------------------------------------------------

export async function net_capture_start(
  ctx: Ctx,
  args: { tabId?: number; urlPattern?: string },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "net.captureStart", args);
  touched(ctx, await resolveTabId(ctx, args.tabId), "started capture", args.urlPattern);
  return r;
}

export async function net_capture_stop(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  await guard(ctx, args.tabId);
  const r = await call(ctx, "net.captureStop", { tabId: args.tabId });
  touched(ctx, await resolveTabId(ctx, args.tabId), "stopped capture");
  return r;
}

export async function net_capture_get(
  ctx: Ctx,
  args: { tabId?: number; clear?: boolean },
): Promise<unknown> {
  return call(ctx, "net.captureGet", args);
}

export async function net_block(
  ctx: Ctx,
  args: { patterns: string[]; enabled: boolean },
): Promise<unknown> {
  return call(ctx, "net.block", args);
}

// -- file upload (dialog bypass) ------------------------------------------------------------------------

export async function upload_file(
  ctx: Ctx,
  args: TargetArgs & { filePath: string },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  const file = await prepareFile(args.filePath);
  const r = await transferFile(ctx.hub, file, args, "inject");
  touched(ctx, await resolveTabId(ctx, args.tabId), "uploaded file", file.fileName);
  return { fileName: file.fileName, bytes: file.totalBytes, ...(r as object) };
}

export async function upload_files(
  ctx: Ctx,
  args: TargetArgs & { filePaths: string[] },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  if (args.filePaths.length > 10) throw toolError("Maximum 10 files per call.");
  const results: unknown[] = [];
  for (const p of args.filePaths) {
    const file = await prepareFile(p);
    results.push(await transferFile(ctx.hub, file, args, "inject"));
  }
  touched(ctx, await resolveTabId(ctx, args.tabId), "uploaded files", `${args.filePaths.length} files`);
  return { count: results.length, results };
}

export async function drag_drop_files(
  ctx: Ctx,
  args: TargetArgs & { filePaths: string[] },
): Promise<unknown> {
  await guard(ctx, args.tabId);
  if (args.filePaths.length > 10) throw toolError("Maximum 10 files per call.");
  const results: unknown[] = [];
  for (const p of args.filePaths) {
    const file = await prepareFile(p);
    results.push(await transferFile(ctx.hub, file, args, "drop"));
  }
  touched(ctx, await resolveTabId(ctx, args.tabId), "dropped files", `${args.filePaths.length} files`);
  return { count: results.length, results };
}

export async function downloads_list(ctx: Ctx, args: { limit?: number }): Promise<unknown> {
  return call(ctx, "downloads.list", args);
}
