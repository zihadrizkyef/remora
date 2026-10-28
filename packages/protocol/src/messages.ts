import { z } from "zod";

/**
 * Wire protocol between the Remora MCP server (WebSocket server) and the
 * Remora Chrome extension (WebSocket client).
 *
 * Frames are JSON text messages in one of three shapes:
 * - WireRequest      MCP -> extension, expects a WireResponse with same id.
 * - WireResponse     extension -> MCP, answers a WireRequest.
 * - WireEvent        extension -> MCP, one-way push (no id).
 * - WireNotification MCP -> extension, one-way push (no id).
 *
 * A receiver distinguishes frames by shape: `method` => request,
 * `ok` => response, `event` => event, `notification` => notification.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WIRE_PROTOCOL_VERSION = 1;
export const DEFAULT_WS_PORT = 47291;
export const WS_PATH = "/remora";
export const WS_HEARTBEAT_MS = 15_000;
export const WS_REQUEST_TIMEOUT_MS = 60_000;
/**
 * The extension pings this often: Chrome only keeps an MV3 worker alive
 * while WebSocket traffic flows at least every 30s.
 */
export const WS_PING_MS = 20_000;
/** Either side drops a link that has been silent this long. */
export const WS_STALE_MS = 45_000;

/** Close codes the hub uses so the extension can tell the user why. */
export const WS_CLOSE = {
  REPLACED: 4000,
  BAD_HELLO: 4002,
  BAD_TOKEN: 4401,
  FORBIDDEN_ORIGIN: 4403,
  UNKNOWN_PATH: 4404,
  STALE: 4408,
} as const;


/**
 * The auth token travels in the WebSocket subprotocol list, not the URL:
 * Chrome prints the full URL of every failed connection on the extension's
 * Errors page. The token is hex-encoded so any value is a legal protocol name.
 */
export const WS_SUBPROTOCOL = "remora";
const TOKEN_PROTOCOL_PREFIX = "remora.token.";

export function tokenProtocols(token: string): string[] {
  const hex = Array.from(new TextEncoder().encode(token), (b) => b.toString(16).padStart(2, "0")).join("");
  return [WS_SUBPROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${hex}`];
}

/** Extract the token from a `Sec-WebSocket-Protocol` header value. */
export function tokenFromProtocols(header: string | undefined): string | null {
  for (const raw of (header ?? "").split(",")) {
    const p = raw.trim();
    if (!p.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
    const hex = p.slice(TOKEN_PROTOCOL_PREFIX.length);
    if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  }
  return null;
}

/** Binary bytes per upload chunk (base64 inflates ~33% on the wire). */
export const UPLOAD_CHUNK_BYTES = 192 * 1024;
/** Hard cap for a single injected file. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Snapshot node cap before truncation notice. */
export const SNAPSHOT_MAX_NODES = 2_000;
/** Text/HTML capture caps. */
export const PAGE_TEXT_MAX_CHARS = 100_000;
export const PAGE_HTML_MAX_CHARS = 200_000;
export const CONSOLE_MAX_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Error codes (stable across versions; MCP maps these to agent messages)
// ---------------------------------------------------------------------------

export const WireErrorCode = z.enum([
  "NO_EXTENSION", // no extension client connected to the hub
  "NO_TAB", // tabId unknown or tab closed
  "NO_CONTENT_SCRIPT", // tab has no content script (chrome://, webstore, ...)
  "TIMEOUT", // extension did not answer in time
  "NOT_ALLOWED", // gated feature disabled (JS eval, net capture) or denied
  "SITE_BLOCKED", // per-site kill-switch is on for this origin
  "BAD_REF", // snapshot ref unknown or stale (take a new snapshot)
  "BAD_ARGS", // params failed validation
  "NOT_FOUND", // selector/coordinate/cookie/... not found
  "NAVIGATED", // page navigated mid-action, refs invalidated
  "OUT_OF_GROUP", // tab is outside this session's Remora tab group
  "UPLOAD_ABORTED", // chunked transfer aborted or tab went away
  "FILE_TOO_LARGE", // exceeds UPLOAD_MAX_BYTES
  "UNKNOWN_METHOD", // method not implemented by this extension version
  "INTERNAL", // unexpected extension-side failure
]);
export type WireErrorCode = z.infer<typeof WireErrorCode>;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const WireRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
  /** Calling agent session; the extension scopes every tab access to its group. */
  agentId: z.string().min(1).optional(),
});
export type WireRequest = z.infer<typeof WireRequestSchema>;

export const WireErrorSchema = z.object({
  code: WireErrorCode,
  message: z.string(),
});
export type WireError = z.infer<typeof WireErrorSchema>;

export const WireResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: WireErrorSchema.optional(),
});
export type WireResponse = z.infer<typeof WireResponseSchema>;

export const WireEventSchema = z.object({
  event: z.string().min(1),
  payload: z.unknown().optional(),
});
export type WireEvent = z.infer<typeof WireEventSchema>;

export const WireNotificationSchema = z.object({
  notification: z.string().min(1),
  payload: z.unknown().optional(),
});
export type WireNotification = z.infer<typeof WireNotificationSchema>;

/** Parse an inbound text frame into exactly one envelope kind. */
export type WireFrame =
  | { kind: "request"; value: WireRequest }
  | { kind: "response"; value: WireResponse }
  | { kind: "event"; value: WireEvent }
  | { kind: "notification"; value: WireNotification };

export function parseWireFrame(raw: string): WireFrame {
  const json: unknown = JSON.parse(raw);
  if (typeof json !== "object" || json === null) {
    throw new Error("wire frame must be an object");
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.method === "string") {
    return { kind: "request", value: WireRequestSchema.parse(json) };
  }
  if (typeof obj.ok === "boolean") {
    return { kind: "response", value: WireResponseSchema.parse(json) };
  }
  if (typeof obj.event === "string") {
    return { kind: "event", value: WireEventSchema.parse(json) };
  }
  if (typeof obj.notification === "string") {
    return { kind: "notification", value: WireNotificationSchema.parse(json) };
  }
  throw new Error("wire frame has no recognizable discriminator");
}

// ---------------------------------------------------------------------------
// Method names (MCP -> extension requests)
// ---------------------------------------------------------------------------

/** Every method the extension must implement, with its params shape. */
export const WireMethods = {
  // -- tabs & windows (background) -----------------------------------------
  "tabs.list": z.object({}).optional(),
  "tabs.activate": z.object({ tabId: z.number().int() }),
  /** Resolve (and access-check) the tab a call will land on. */
  "tabs.resolve": z.object({ tabId: z.number().int().optional() }),
  "tabs.create": z.object({
    url: z.string().optional(),
    active: z.boolean().optional(),
    label: z.string().optional(),
  }),
  "tabs.close": z.object({ tabId: z.number().int().optional() }),
  "tabs.duplicate": z.object({ tabId: z.number().int().optional(), label: z.string().optional() }),
  "tabs.pin": z.object({ tabId: z.number().int().optional(), pinned: z.boolean() }),
  "tabs.mute": z.object({ tabId: z.number().int().optional(), muted: z.boolean() }),
  "tabs.move": z.object({
    tabId: z.number().int().optional(),
    index: z.number().int(),
    windowId: z.number().int().optional(),
  }),
  "windows.list": z.object({}).optional(),
  /** This session's group plus how many other tabs are hidden from it. */
  "session.info": z.object({}).optional(),

  // -- navigation (background) ----------------------------------------------
  navigate: z.object({
    tabId: z.number().int().optional(),
    url: z.string().url(),
  }),
  "nav.back": z.object({ tabId: z.number().int().optional() }),
  "nav.forward": z.object({ tabId: z.number().int().optional() }),
  "nav.reload": z.object({
    tabId: z.number().int().optional(),
    hard: z.boolean().optional(),
  }),

  // -- perception (content script, routed by background) ---------------------
  snapshot: z.object({
    tabId: z.number().int().optional(),
    compact: z.boolean().optional(),
  }),
  "page.text": z.object({
    tabId: z.number().int().optional(),
    maxChars: z.number().int().positive().optional(),
  }),
  "page.html": z.object({
    tabId: z.number().int().optional(),
    selector: z.string().optional(),
    ref: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
  }),
  query: z.object({
    tabId: z.number().int().optional(),
    selector: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }),
  "page.info": z.object({ tabId: z.number().int().optional() }),
  "console.logs": z.object({
    tabId: z.number().int().optional(),
    level: z.enum(["log", "info", "warn", "error", "debug", "all"]).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  "page.errors": z.object({
    tabId: z.number().int().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),

  // -- visual (background + content overlay) ---------------------------------
  screenshot: z.object({
    tabId: z.number().int().optional(),
    mode: z.enum(["viewport", "fullPage", "selector", "ref"]).optional(),
    selector: z.string().optional(),
    ref: z.string().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  "annotate.show": z.object({ tabId: z.number().int().optional() }),
  "annotate.hide": z.object({ tabId: z.number().int().optional() }),
  "export.pdf": z.object({
    tabId: z.number().int().optional(),
    landscape: z.boolean().optional(),
  }),

  // -- interaction (content script) ------------------------------------------
  click: z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  hover: z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  type: z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    text: z.string(),
    submit: z.boolean().optional(),
    clearFirst: z.boolean().optional(),
  }),
  "form.fill": z.object({
    tabId: z.number().int().optional(),
    fields: z.array(
      z.object({
        ref: z.string().optional(),
        selector: z.string().optional(),
        name: z.string().optional(),
        value: z.string(),
      }),
    ).min(1),
    submit: z.boolean().optional(),
  }),
  "select.option": z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    values: z.array(z.string()).min(1),
  }),
  "set.checked": z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    checked: z.boolean(),
  }),
  scroll: z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
    pixels: z.number().int().positive().optional(),
    intoView: z.boolean().optional(),
  }),
  drag: z.object({
    tabId: z.number().int().optional(),
    fromRef: z.string().optional(),
    fromSelector: z.string().optional(),
    toRef: z.string().optional(),
    toSelector: z.string().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
  }),
  "press.key": z.object({
    tabId: z.number().int().optional(),
    key: z.string().min(1),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  focus: z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),

  // -- clipboard --------------------------------------------------------------
  "clipboard.read": z.object({}),
  "clipboard.write": z.object({ text: z.string() }),
  "clipboard.copyFrom": z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  "clipboard.pasteTo": z.object({
    tabId: z.number().int().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    base64: z.string().optional(),
  }),

  // -- waiting -----------------------------------------------------------------
  "wait.for": z.object({
    tabId: z.number().int().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    navigation: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),

  // -- JS & storage (gated for JS) ----------------------------------------------
  evaluate: z.object({
    tabId: z.number().int().optional(),
    expression: z.string().min(1),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  }),
  "cookies.list": z.object({ url: z.string().optional() }),
  "cookies.set": z.object({
    url: z.string().url(),
    name: z.string().min(1),
    value: z.string(),
    expirationDate: z.number().optional(),
  }),
  "cookies.clear": z.object({ url: z.string().optional() }),
  "storage.get": z.object({
    tabId: z.number().int().optional(),
    area: z.enum(["local", "session"]),
    keys: z.array(z.string()).optional(),
  }),
  "storage.set": z.object({
    tabId: z.number().int().optional(),
    area: z.enum(["local", "session"]),
    entries: z.record(z.string()),
    remove: z.array(z.string()).optional(),
  }),

  // -- network (background, webRequest; gated) -----------------------------------
  "net.captureStart": z.object({
    tabId: z.number().int().optional(),
    urlPattern: z.string().optional(),
  }),
  "net.captureStop": z.object({ tabId: z.number().int().optional() }),
  "net.captureGet": z.object({
    tabId: z.number().int().optional(),
    clear: z.boolean().optional(),
  }),
  "net.block": z.object({
    patterns: z.array(z.string()).optional(),
    enabled: z.boolean(),
  }),

  // -- uploads: chunked pipeline (MCP reads file, content injects) -----------------
  "upload.begin": z.object({
    tabId: z.number().int().optional(),
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    totalBytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
    chunks: z.number().int().positive(),
  }),
  "upload.chunk": z.object({
    tabId: z.number().int().optional(),
    transferId: z.string().min(1),
    index: z.number().int().nonnegative(),
    base64: z.string().min(1),
  }),
  "upload.inject": z.object({
    tabId: z.number().int().optional(),
    transferId: z.string().min(1),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  "upload.drop": z.object({
    tabId: z.number().int().optional(),
    transferId: z.string().min(1),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  "upload.abort": z.object({ tabId: z.number().int().optional(), transferId: z.string().min(1) }),
  "downloads.list": z.object({
    limit: z.number().int().positive().max(100).optional(),
  }),
} satisfies Record<string, z.ZodTypeAny | undefined>;

export type WireMethodName = keyof typeof WireMethods;

export function validateMethodParams(
  method: string,
  params: unknown,
): { ok: true } | { ok: false; message: string } {
  const schema = (WireMethods as Record<string, z.ZodTypeAny | undefined>)[method];
  if (!schema) return { ok: false, message: `unknown method: ${method}` };
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Event payloads (extension -> MCP)
// ---------------------------------------------------------------------------

export const ExtensionHelloPayloadSchema = z.object({
  version: z.string(),
  protocol: z.number().int(),
  tabCount: z.number().int().nonnegative(),
});
export type ExtensionHelloPayload = z.infer<typeof ExtensionHelloPayloadSchema>;

export const AgentActivityPayloadSchema = z.object({
  tabId: z.number().int(),
  action: z.string(),
  target: z.string().optional(),
  ts: z.number().int(),
});
export type AgentActivityPayload = z.infer<typeof AgentActivityPayloadSchema>;

/** Task context carried by `activity.show` while a task is running. */
export const TaskSnapshotSchema = z.object({
  label: z.string().optional(),
  startedAt: z.number().int(),
  step: z.number().int().nonnegative(),
});
export type TaskSnapshotPayload = z.infer<typeof TaskSnapshotSchema>;

/** `task.end` notification (MCP -> extension): releases a tab's indicators. */
export const TaskEndPayloadSchema = z.object({
  tabId: z.number().int(),
  agentId: z.string().optional(),
  outcome: z.enum(["done", "timeout", "aborted"]),
  label: z.string().optional(),
  steps: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type TaskEndPayload = z.infer<typeof TaskEndPayloadSchema>;

export const TabClosedPayloadSchema = z.object({ tabId: z.number().int(), agentId: z.string().optional() });
export const NavigatedPayloadSchema = z.object({
  tabId: z.number().int(),
  agentId: z.string().optional(),
  url: z.string(),
  title: z.string(),
});
export const UploadProgressPayloadSchema = z.object({
  transferId: z.string(),
  tabId: z.number().int(),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Notifications (MCP -> extension)
// ---------------------------------------------------------------------------

export const ShowActivityPayloadSchema = z.object({
  tabId: z.number().int(),
  agentId: z.string().optional(),
  action: z.string().optional(),
  /** Human-safe target label; MUST NOT contain typed text. */
  target: z.string().optional(),
  task: TaskSnapshotSchema.optional(),
});
export type ShowActivityPayload = z.infer<typeof ShowActivityPayloadSchema>;

/** `session.end` (MCP -> extension): the agent process is gone; release its group. */
export const SessionEndPayloadSchema = z.object({ agentId: z.string().min(1) });
export type SessionEndPayload = z.infer<typeof SessionEndPayloadSchema>;

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

export const TabInfoSchema = z.object({
  id: z.number().int(),
  windowId: z.number().int(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  pinned: z.boolean(),
  audible: z.boolean().optional(),
  muted: z.boolean().optional(),
  status: z.string().optional(),
  groupId: z.number().int().optional(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const SnapshotNodeSchema: z.ZodType<SnapshotNode> = z.lazy(() =>
  z.object({
    ref: z.string(),
    role: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    checked: z.boolean().optional(),
    disabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    children: z.array(SnapshotNodeSchema).optional(),
  }),
);
export interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  focused?: boolean;
  children?: SnapshotNode[];
}

export const SnapshotResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** Playwright-style text tree; refs embedded (e.g. `[ref=e12]`). */
  text: z.string(),
  truncated: z.boolean(),
  nodeCount: z.number().int(),
});
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;
