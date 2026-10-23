import { z } from "zod";

/**
 * MCP tool catalog. Each entry defines the agent-facing tool name,
 * its human description, and the zod schema for its arguments.
 *
 * The MCP server registers these with the SDK; the extension implements
 * the matching wire methods (see messages.ts `WireMethods`).
 */

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Short label used for the in-page activity pill. */
  activity: string;
}

const tabId = z.number().int().describe("Target tab id (default: active tab)").optional();

/** Locate an element: snapshot ref preferred, CSS selector fallback. */
const target = {
  ref: z.string().describe("Element ref from snapshot, e.g. e12").optional(),
  selector: z.string().describe("CSS selector fallback").optional(),
};

function def(name: string, description: string, activity: string, schema: z.ZodRawShape): ToolDef {
  return { name, description, activity, schema };
}

export const TOOL_DEFS: ToolDef[] = [
  // -- connection -------------------------------------------------------------
  def("remora_status", "Remora bridge status: extension connected, versions, tab count, tabs currently showing agent activity.", "status check", {}),

  def("task_begin", "Announce the start of a task. Remora keeps its on-screen 'agent active' indicators lit until you call task_end. Call this first, with a short label such as 'Cari headset termurah'.", "starting task", {
    label: z.string().describe("Short task name shown to the user (max 60 chars)").optional(),
  }),
  def("task_end", "Announce that your task is finished, successfully or not. ALWAYS call this when you are done using the browser, before your final answer; otherwise the indicators stay lit until a 90s idle timeout and show the agent as cut off.", "finishing task", {}),

  // -- tabs & windows -----------------------------------------------------------
  def("tabs_list", "List all open tabs across windows (id, title, url, active, pinned).", "listing tabs", {}),
  def("tab_activate", "Activate (focus) a tab by id.", "activating tab", { tabId: z.number().int().describe("Tab id to activate") }),
  def("tab_create", "Open a new tab, optionally with a URL.", "opening tab", {
    url: z.string().describe("URL to open (optional)").optional(),
    active: z.boolean().describe("Focus the new tab (default true)").optional(),
  }),
  def("tab_close", "Close a tab by id (default: active tab).", "closing tab", { tabId }),
  def("tab_duplicate", "Duplicate a tab (default: active tab).", "duplicating tab", { tabId }),
  def("tab_pin", "Pin or unpin a tab.", "pinning tab", { tabId, pinned: z.boolean() }),
  def("tab_mute", "Mute or unmute a tab.", "muting tab", { tabId, muted: z.boolean() }),
  def("tab_move", "Move a tab to a new index, optionally to another window.", "moving tab", {
    tabId,
    index: z.number().int().describe("New zero-based index"),
    windowId: z.number().int().describe("Target window id (optional)").optional(),
  }),
  def("tab_claim", "Claim a tab for exclusive use by this agent session. Other sessions are blocked from touching it until released. Tabs you create are auto-claimed.", "claiming tab", {
    tabId,
    note: z.string().describe("Short note shown to other agents, e.g. what you are doing").optional(),
  }),
  def("tab_release", "Release a tab you claimed so other agents may use it.", "releasing tab", { tabId }),
  def("windows_list", "List browser windows (id, focused, tab count).", "listing windows", {}),

  // -- navigation ---------------------------------------------------------------
  def("navigate", "Navigate a tab to a URL (http/https).", "navigating", {
    tabId,
    url: z.string().describe("Full URL including scheme"),
  }),
  def("go_back", "Go back in tab history.", "going back", { tabId }),
  def("go_forward", "Go forward in tab history.", "going forward", { tabId }),
  def("reload", "Reload a tab; hard=true bypasses cache.", "reloading", {
    tabId,
    hard: z.boolean().optional(),
  }),

  // -- perception -----------------------------------------------------------------
  def("snapshot", "Capture the page accessibility tree with element refs ([ref=e12]). Always call before interacting; refs expire on navigation.", "reading page", {
    tabId,
    compact: z.boolean().describe("Drop unnamed containers (default true)").optional(),
  }),
  def("page_text", "Get visible text content of the page (truncated).", "reading text", {
    tabId,
    maxChars: z.number().int().positive().optional(),
  }),
  def("page_html", "Get HTML of the page or a sub-element (truncated).", "reading HTML", {
    tabId,
    ...target,
    maxChars: z.number().int().positive().optional(),
  }),
  def("query", "Count/match elements by CSS selector; returns up to `limit` matches with text and attributes.", "querying page", {
    tabId,
    selector: z.string(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  def("page_info", "Get URL, title, and ready state of a tab.", "reading page info", { tabId }),
  def("console_logs", "Read captured console messages for the tab.", "reading console", {
    tabId,
    level: z.enum(["log", "info", "warn", "error", "debug", "all"]).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  def("page_errors", "Read uncaught page errors (window.onerror + unhandled rejections).", "reading errors", {
    tabId,
    limit: z.number().int().positive().max(100).optional(),
  }),

  // -- visual -----------------------------------------------------------------------
  def("screenshot", "Screenshot viewport, full page, or one element (base64 PNG/JPEG).", "taking screenshot", {
    tabId,
    mode: z.enum(["viewport", "fullPage", "selector", "ref"]).optional(),
    ...target,
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).describe("JPEG quality").optional(),
  }),
  def("screenshot_annotated", "Screenshot with numbered badges over interactive elements for grounding; badge numbers map to snapshot refs.", "taking annotated screenshot", { tabId }),
  def("export_pdf", "Export the page as PDF (base64).", "exporting PDF", {
    tabId,
    landscape: z.boolean().optional(),
  }),

  // -- interaction --------------------------------------------------------------------
  def("click", "Click an element by snapshot ref or selector.", "clicking", {
    tabId,
    ...target,
    button: z.enum(["left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(1).max(3).describe("1=click, 2=double, 3=triple").optional(),
  }),
  def("hover", "Hover an element (reveals menus/tooltips).", "hovering", { tabId, ...target }),
  def("type", "Type text into an input (clears first by default).", "typing", {
    tabId,
    ...target,
    text: z.string(),
    submit: z.boolean().describe("Press Enter after typing").optional(),
    clearFirst: z.boolean().describe("Clear field first (default true)").optional(),
  }),
  def("fill_form", "Fill multiple fields in one call; locate by ref, selector, or field name.", "filling form", {
    tabId,
    fields: z.array(z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      name: z.string().describe("name/id/placeholder/label match").optional(),
      value: z.string(),
    })).min(1),
    submit: z.boolean().describe("Submit the form after filling").optional(),
  }),
  def("select_option", "Choose option(s) in a <select> by value or visible text.", "selecting option", {
    tabId,
    ...target,
    values: z.array(z.string()).min(1),
  }),
  def("set_checked", "Check/uncheck a checkbox or radio.", "toggling checkbox", {
    tabId,
    ...target,
    checked: z.boolean(),
  }),
  def("scroll", "Scroll the page or an element; or scroll an element into view.", "scrolling", {
    tabId,
    ...target,
    direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
    pixels: z.number().int().positive().optional(),
    intoView: z.boolean().describe("Scroll target element into view").optional(),
  }),
  def("drag", "Drag from one element to another element or page coordinates.", "dragging", {
    tabId,
    fromRef: z.string().optional(),
    fromSelector: z.string().optional(),
    toRef: z.string().optional(),
    toSelector: z.string().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
  }),
  def("press_key", "Press a key or shortcut (Enter, Tab, Escape, a, Control+c, ...).", "pressing key", {
    tabId,
    key: z.string(),
    ...target,
  }),
  def("focus", "Focus an element without clicking.", "focusing", { tabId, ...target }),

  // -- clipboard ------------------------------------------------------------------------
  def("clipboard_read", "Read text from the OS clipboard.", "reading clipboard", {}),
  def("clipboard_write", "Write text to the OS clipboard.", "writing clipboard", { text: z.string() }),
  def("clipboard_copy_from", "Select an element's text and copy it to the clipboard.", "copying", {
    tabId,
    ...target,
  }),
  def("clipboard_paste_to", "Paste into an element: from OS clipboard, or inject a pasted file (bypasses file dialogs).", "pasting", {
    tabId,
    ...target,
    filePath: z.string().describe("Local file to paste as file content (optional)").optional(),
  }),

  // -- waiting ----------------------------------------------------------------------------
  def("wait_for", "Wait for a selector, text, or navigation (default timeout 30s).", "waiting", {
    tabId,
    selector: z.string().optional(),
    text: z.string().describe("Text to appear in the page").optional(),
    navigation: z.boolean().describe("Wait for next navigation/commit").optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  def("sleep", "Wait a fixed number of milliseconds (prefer wait_for).", "waiting", {
    ms: z.number().int().positive().max(60_000),
  }),

  // -- JS & storage ---------------------------------------------------------------------------
  def("evaluate_js", "Evaluate JavaScript in the page (MAIN world). GATED: disabled unless the user enables 'JS eval' in the popup.", "running script", {
    tabId,
    expression: z.string(),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  }),
  def("cookies_list", "List cookies, optionally filtered by URL.", "reading cookies", {
    url: z.string().optional(),
  }),
  def("cookies_set", "Set a cookie for a URL.", "setting cookie", {
    url: z.string(),
    name: z.string(),
    value: z.string(),
    expirationDate: z.number().describe("Unix seconds (optional)").optional(),
  }),
  def("cookies_clear", "Clear cookies, optionally filtered by URL.", "clearing cookies", {
    url: z.string().optional(),
  }),
  def("storage_get", "Read localStorage/sessionStorage keys (omit keys for all).", "reading storage", {
    tabId,
    area: z.enum(["local", "session"]),
    keys: z.array(z.string()).optional(),
  }),
  def("storage_set", "Write/remove localStorage/sessionStorage entries.", "writing storage", {
    tabId,
    area: z.enum(["local", "session"]),
    entries: z.record(z.string()).describe("Key/value pairs to set").optional(),
    remove: z.array(z.string()).describe("Keys to remove").optional(),
  }),

  // -- network ------------------------------------------------------------------------------------
  def("net_capture_start", "Start capturing network requests for a tab. GATED: needs 'Network capture' enabled in the popup.", "starting capture", {
    tabId,
    urlPattern: z.string().describe("Substring filter (optional)").optional(),
  }),
  def("net_capture_stop", "Stop capturing for a tab.", "stopping capture", { tabId }),
  def("net_capture_get", "Get captured requests (method, url, status, timing).", "reading capture", {
    tabId,
    clear: z.boolean().describe("Clear buffer after reading").optional(),
  }),
  def("net_block", "Enable/disable request blocking by URL substring patterns. Patterns are required when enabling, and ignored when disabling.", "blocking requests", {
    patterns: z.array(z.string()).describe("URL substring patterns; required when enabled=true").optional(),
    enabled: z.boolean(),
  }),

  // -- file upload (dialog bypass) ------------------------------------------------------------------
  def("upload_file", "Upload ONE local file into a file input WITHOUT clicking (no Explorer dialog). agent never touches the button.", "uploading file", {
    tabId,
    ...target,
    filePath: z.string().describe("Absolute local path, e.g. D:/docs/report.pdf"),
  }),
  def("upload_files", "Upload MULTIPLE local files into one file input (no dialog).", "uploading files", {
    tabId,
    ...target,
    filePaths: z.array(z.string()).min(1),
  }),
  def("drag_drop_files", "Drop local files onto a dropzone element (synthetic drag events, no dialog).", "dropping files", {
    tabId,
    ...target,
    filePaths: z.array(z.string()).min(1),
  }),
  def("downloads_list", "List recent downloads (filename, state, path).", "listing downloads", {
    limit: z.number().int().positive().max(100).optional(),
  }),
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
