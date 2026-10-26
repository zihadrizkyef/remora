import {
  AgentActivityPayload,
  OUT_OF_GROUP_MESSAGE,
  TAB_GROUP_NONE,
  TabInfo,
  WireError,
  WireMethodName,
} from "@remora/protocol";
import type { RemoraHub } from "../hub.js";
import { listActive, summarize } from "../activity.js";
import { prepareFile, toolError, transferFile } from "../uploads.js";

/**
 * Tool implementations. Each handler receives validated args and returns a
 * JSON-serializable result. Handlers that touch a tab resolve it through
 * `guard` (the extension enforces the session's tab group) and emit
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
      case "OUT_OF_GROUP":
        return toolError(
          `OUT_OF_GROUP: ${err.message}. You may only use tabs in your own Remora tab group: call tabs_list for them, or tab_create for a new one.`,
        );
      case "NO_TAB":
        return toolError("Tab not found (it may have been closed). Call `tabs_list` for your tabs.");
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

function touched(ctx: Ctx, tabId: number, activity: string, target?: string): void {
  ctx.hub.touch(tabId, activity, target);
}

const outOfGroup = () => toAgentError({ code: "OUT_OF_GROUP", message: OUT_OF_GROUP_MESSAGE });

/**
 * Resolve the tab a call lands on. The extension enforces the group (explicit
 * tabId must be in it; no tabId means this session's working tab, never the
 * window's active tab). The answer is re-checked here as defense in depth.
 */
async function guard(ctx: Ctx, tabId?: number): Promise<number> {
  const r = await call<{ tabId: number; groupId: number }>(ctx, "tabs.resolve", { tabId });
  const known = ctx.hub.groupId;
  if (
    (tabId !== undefined && r.tabId !== tabId) ||
    r.groupId === TAB_GROUP_NONE ||
    (known !== undefined && r.groupId !== known)
  ) {
    throw outOfGroup();
  }
  ctx.hub.groupId = r.groupId;
  return r.tabId;
}

/** Keep only rows of this session's group, whatever the extension sent. */
function ownRows(ctx: Ctx, tabs: unknown): TabInfo[] {
  if (!Array.isArray(tabs)) return [];
  const gid = ctx.hub.groupId;
  return (tabs as TabInfo[]).filter(
    (t) =>
      typeof t?.groupId === "number" &&
      t.groupId !== TAB_GROUP_NONE &&
      (gid === undefined || t.groupId === gid),
  );
}

// -- connection ---------------------------------------------------------------

interface SessionInfo {
  groupId: number | null;
  title?: string;
  windowId?: number;
  tabIds: number[];
  hiddenTabCount: number;
}

export async function remora_status(ctx: Ctx): Promise<unknown> {
  // Every MCP session shares one hub; `hubRole` tells a user whether this
  // process owns the port or is forwarding to the session that does.
  const hubRole = ctx.hub.isPrimary ? "primary" : "attached";
  if (!ctx.hub.connected) {
    return {
      connected: false,
      hubRole,
      agentId: ctx.hub.agentId,
      hint: "Extension not connected. Ask the user to open Chrome with Remora installed and paired.",
    };
  }
  const session = await call<SessionInfo>(ctx, "session.info", {});
  const mine = new Set(session.tabIds);
  const active: AgentActivityPayload[] = listActive()
    .filter((a) => mine.has(a.tabId))
    .map((a) => ({ tabId: a.tabId, action: a.action, target: a.target, ts: a.ts }));
  const ext = ctx.hub.extension;
  return {
    connected: true,
    hubRole,
    extensionVersion: ext?.version ?? "unknown",
    protocol: ext?.protocol ?? 1,
    agentId: ctx.hub.agentId,
    task: ctx.hub.tasks.active ? { label: ctx.hub.tasks.label ?? null } : null,
    group:
      session.groupId === null
        ? null
        : { groupId: session.groupId, title: session.title, windowId: session.windowId, tabCount: session.tabIds.length },
    hiddenTabs: `${session.hiddenTabCount} tab lain disembunyikan`,
    activeTabs: active,
    ...(session.groupId === null ? { hint: "No Remora tab group yet. Call tab_create to open your first tab." } : {}),
  };
}

// -- task lifecycle -------------------------------------------------------------

export async function task_begin(ctx: Ctx, args: { label?: string }): Promise<unknown> {
  const task = ctx.hub.tasks.begin(args.label);
  return { started: true, label: task.label ?? null, hint: "Call task_end when you are done." };
}

export async function task_end(ctx: Ctx): Promise<unknown> {
  const ended = ctx.hub.tasks.end("done");
  if (!ended) return { ended: false, note: "no task was running" };
  return { ended: true, label: ended.label ?? null, steps: ended.steps, durationMs: ended.durationMs };
}

// -- tabs & windows -------------------------------------------------------------

export async function tabs_list(ctx: Ctx): Promise<unknown> {
  return ownRows(ctx, await call(ctx, "tabs.list", {}));
}

export async function tab_activate(ctx: Ctx, args: { tabId: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.activate", { tabId: id });
  touched(ctx, id, "activated tab");
  return r;
}

/** A new tab lands in this session's group (created on first use). */
function adoptNewTab(ctx: Ctx, tab: TabInfo): void {
  if (typeof tab.groupId !== "number" || tab.groupId === TAB_GROUP_NONE) throw outOfGroup();
  ctx.hub.groupId = tab.groupId;
}

export async function tab_create(ctx: Ctx, args: { url?: string; active?: boolean }): Promise<unknown> {
  const tab = await call<TabInfo>(ctx, "tabs.create", { ...args, label: ctx.hub.tasks.label });
  adoptNewTab(ctx, tab);
  touched(ctx, tab.id, "opened tab", tab.url || tab.title);
  return tab;
}

export async function tab_close(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.close", { tabId: id });
  touched(ctx, id, "closed tab");
  return r;
}

export async function tab_duplicate(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const tab = await call<TabInfo>(ctx, "tabs.duplicate", { tabId: id, label: ctx.hub.tasks.label });
  adoptNewTab(ctx, tab);
  touched(ctx, tab.id, "duplicated tab", tab.title);
  return tab;
}

export async function tab_pin(ctx: Ctx, args: { tabId?: number; pinned: boolean }): Promise<unknown> {
  if (args.pinned) {
    throw toolError("Pinning is refused: Chrome removes pinned tabs from their group, which would end your access.");
  }
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.pin", { tabId: id, pinned: false });
  touched(ctx, id, "unpinned tab");
  return r;
}

export async function tab_mute(ctx: Ctx, args: { tabId?: number; muted: boolean }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.mute", { tabId: id, muted: args.muted });
  touched(ctx, id, args.muted ? "muted tab" : "unmuted tab");
  return r;
}

export async function tab_move(
  ctx: Ctx,
  args: { tabId?: number; index: number; windowId?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "tabs.move", { ...args, tabId: id });
  touched(ctx, id, "moved tab");
  return r;
}

export async function windows_list(ctx: Ctx): Promise<unknown> {
  return call(ctx, "windows.list", {});
}

// -- navigation -------------------------------------------------------------------

export async function navigate(ctx: Ctx, args: { tabId?: number; url: string }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "navigate", { ...args, tabId: id });
  touched(ctx, id, "navigated", args.url);
  return r;
}

export async function go_back(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.back", { tabId: id });
  touched(ctx, id, "went back");
  return r;
}

export async function go_forward(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.forward", { tabId: id });
  touched(ctx, id, "went forward");
  return r;
}

export async function reload(ctx: Ctx, args: { tabId?: number; hard?: boolean }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "nav.reload", { ...args, tabId: id });
  touched(ctx, id, "reloaded");
  return r;
}

// -- perception ---------------------------------------------------------------------

export async function snapshot(ctx: Ctx, args: { tabId?: number; compact?: boolean }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "snapshot", { ...args, tabId: id });
  touched(ctx, id, "read page");
  return r;
}

export async function page_text(ctx: Ctx, args: { tabId?: number; maxChars?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "page.text", { ...args, tabId: id });
  touched(ctx, id, "read text");
  return r;
}

export async function page_html(
  ctx: Ctx,
  args: { tabId?: number; ref?: string; selector?: string; maxChars?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "page.html", { ...args, tabId: id });
  touched(ctx, id, "read HTML");
  return r;
}

export async function query(
  ctx: Ctx,
  args: { tabId?: number; selector: string; limit?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "query", { ...args, tabId: id });
  touched(ctx, id, "queried page", args.selector);
  return r;
}

export async function page_info(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  return call(ctx, "page.info", { tabId: id });
}

export async function console_logs(
  ctx: Ctx,
  args: { tabId?: number; level?: string; limit?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  return call(ctx, "console.logs", { ...args, tabId: id });
}

export async function page_errors(ctx: Ctx, args: { tabId?: number; limit?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  return call(ctx, "page.errors", { ...args, tabId: id });
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "screenshot", { ...args, tabId: id });
  touched(ctx, id, "took screenshot");
  return r;
}

export async function screenshot_annotated(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  await call(ctx, "annotate.show", { tabId: id });
  try {
    const shot = await call(ctx, "screenshot", { tabId: id, mode: "viewport" });
    touched(ctx, id, "took annotated screenshot");
    return shot;
  } finally {
    await call(ctx, "annotate.hide", { tabId: id }).catch(() => undefined);
  }
}

export async function export_pdf(
  ctx: Ctx,
  args: { tabId?: number; landscape?: boolean },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "export.pdf", { ...args, tabId: id });
  touched(ctx, id, "exported PDF");
  return r;
}

// -- interaction --------------------------------------------------------------------------

type TargetArgs = { tabId?: number; ref?: string; selector?: string };
const labelOf = (a: TargetArgs) => a.ref ?? a.selector;

export async function click(
  ctx: Ctx,
  args: TargetArgs & { button?: "left" | "middle" | "right"; clickCount?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "click", { ...args, tabId: id });
  touched(ctx, id, "clicked", summarize("element", labelOf(args)));
  return r;
}

export async function hover(ctx: Ctx, args: TargetArgs): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "hover", { ...args, tabId: id });
  touched(ctx, id, "hovered", labelOf(args));
  return r;
}

export async function type(
  ctx: Ctx,
  args: TargetArgs & { text: string; submit?: boolean; clearFirst?: boolean },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "type", { ...args, tabId: id });
  touched(ctx, id, "typed", `into ${labelOf(args) ?? "field"}`);
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "form.fill", { ...args, tabId: id });
  touched(ctx, id, "filled form", `${args.fields.length} fields`);
  return r;
}

export async function select_option(
  ctx: Ctx,
  args: TargetArgs & { values: string[] },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "select.option", { ...args, tabId: id });
  touched(ctx, id, "selected option", args.values.join(", "));
  return r;
}

export async function set_checked(ctx: Ctx, args: TargetArgs & { checked: boolean }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "set.checked", { ...args, tabId: id });
  touched(ctx, id, args.checked ? "checked" : "unchecked", labelOf(args));
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "scroll", { ...args, tabId: id });
  const what = args.intoView ? `to ${labelOf(args)}` : (args.direction ?? "page");
  touched(ctx, id, "scrolled", what);
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "drag", { ...args, tabId: id });
  touched(ctx, id, "dragged");
  return r;
}

export async function press_key(ctx: Ctx, args: TargetArgs & { key: string }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "press.key", { ...args, tabId: id });
  touched(ctx, id, "pressed key", args.key);
  return r;
}

export async function focus(ctx: Ctx, args: TargetArgs): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "focus", { ...args, tabId: id });
  touched(ctx, id, "focused", labelOf(args));
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "clipboard.copyFrom", { ...args, tabId: id });
  touched(ctx, id, "copied", labelOf(args));
  return r;
}

export async function clipboard_paste_to(
  ctx: Ctx,
  args: TargetArgs & { filePath?: string },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  if (args.filePath) {
    const file = await prepareFile(args.filePath);
    const r = await call(ctx, "clipboard.pasteTo", {
      tabId: id,
      ref: args.ref,
      selector: args.selector,
      filePath: args.filePath,
      fileName: file.fileName,
      mimeType: file.mimeType,
      base64: file.data.toString("base64"),
    });
    touched(ctx, id, "pasted file", file.fileName);
    return r;
  }
  const r = await call(ctx, "clipboard.pasteTo", { tabId: id, ref: args.ref, selector: args.selector });
  touched(ctx, id, "pasted", labelOf(args));
  return r;
}

// -- waiting ------------------------------------------------------------------------------------

export async function wait_for(
  ctx: Ctx,
  args: { tabId?: number; selector?: string; text?: string; navigation?: boolean; timeoutMs?: number },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "wait.for", { ...args, tabId: id }, Math.min((args.timeoutMs ?? 30_000) + 5_000, 130_000));
  touched(
    ctx,
    id,
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "evaluate", { ...args, tabId: id });
  touched(ctx, id, "ran script");
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
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "storage.get", { ...args, tabId: id });
  touched(ctx, id, `read ${args.area}Storage`);
  return r;
}

export async function storage_set(
  ctx: Ctx,
  args: { tabId?: number; area: "local" | "session"; entries?: Record<string, string>; remove?: string[] },
): Promise<unknown> {
  if (!args.entries && !args.remove) throw toolError("Provide `entries` and/or `remove`.");
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "storage.set", { ...args, tabId: id });
  touched(ctx, id, `wrote ${args.area}Storage`);
  return r;
}

// -- network ------------------------------------------------------------------------------------------

export async function net_capture_start(
  ctx: Ctx,
  args: { tabId?: number; urlPattern?: string },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "net.captureStart", { ...args, tabId: id });
  touched(ctx, id, "started capture", args.urlPattern);
  return r;
}

export async function net_capture_stop(ctx: Ctx, args: { tabId?: number }): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  const r = await call(ctx, "net.captureStop", { tabId: id });
  touched(ctx, id, "stopped capture");
  return r;
}

export async function net_capture_get(
  ctx: Ctx,
  args: { tabId?: number; clear?: boolean },
): Promise<unknown> {
  const id = await guard(ctx, args.tabId);
  return call(ctx, "net.captureGet", { ...args, tabId: id });
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
  const id = await guard(ctx, args.tabId);
  const file = await prepareFile(args.filePath);
  const r = await transferFile(ctx.hub, file, { ...args, tabId: id }, "inject");
  touched(ctx, id, "uploaded file", file.fileName);
  return { fileName: file.fileName, bytes: file.totalBytes, ...(r as object) };
}

export async function upload_files(
  ctx: Ctx,
  args: TargetArgs & { filePaths: string[] },
): Promise<unknown> {
  if (args.filePaths.length > 10) throw toolError("Maximum 10 files per call.");
  const id = await guard(ctx, args.tabId);
  const results: unknown[] = [];
  for (const p of args.filePaths) {
    const file = await prepareFile(p);
    results.push(await transferFile(ctx.hub, file, { ...args, tabId: id }, "inject"));
  }
  touched(ctx, id, "uploaded files", `${args.filePaths.length} files`);
  return { count: results.length, results };
}

export async function drag_drop_files(
  ctx: Ctx,
  args: TargetArgs & { filePaths: string[] },
): Promise<unknown> {
  if (args.filePaths.length > 10) throw toolError("Maximum 10 files per call.");
  const id = await guard(ctx, args.tabId);
  const results: unknown[] = [];
  for (const p of args.filePaths) {
    const file = await prepareFile(p);
    results.push(await transferFile(ctx.hub, file, { ...args, tabId: id }, "drop"));
  }
  touched(ctx, id, "dropped files", `${args.filePaths.length} files`);
  return { count: results.length, results };
}

export async function downloads_list(ctx: Ctx, args: { limit?: number }): Promise<unknown> {
  return call(ctx, "downloads.list", args);
}
