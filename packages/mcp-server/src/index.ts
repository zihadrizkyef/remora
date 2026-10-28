#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_DEFS } from "@remora/protocol";
import { loadConfig } from "./config.js";
import { RemoraHub } from "./hub.js";
import * as H from "./tools/handlers.js";
import type { Ctx } from "./tools/handlers.js";

/**
 * Remora MCP server entry.
 * - Speaks MCP over stdio (for Claude Desktop / ZCode / other clients).
 * - Hosts the WebSocket hub on 127.0.0.1 for the Chrome extension.
 *
 * All tool schemas come from @remora/protocol so agent-facing validation
 * and docs stay in one place; handlers live in ./tools/handlers.
 */

const HANDLERS: Record<string, (ctx: Ctx, args: never) => Promise<unknown>> = {
  remora_status: (ctx) => H.remora_status(ctx),
  task_begin: (ctx, a) => H.task_begin(ctx, a),
  task_end: (ctx) => H.task_end(ctx),
  tabs_list: (ctx) => H.tabs_list(ctx),
  tab_activate: (ctx, a) => H.tab_activate(ctx, a),
  tab_create: (ctx, a) => H.tab_create(ctx, a),
  tab_close: (ctx, a) => H.tab_close(ctx, a),
  tab_duplicate: (ctx, a) => H.tab_duplicate(ctx, a),
  tab_pin: (ctx, a) => H.tab_pin(ctx, a),
  tab_mute: (ctx, a) => H.tab_mute(ctx, a),
  tab_move: (ctx, a) => H.tab_move(ctx, a),
  windows_list: (ctx) => H.windows_list(ctx),
  navigate: (ctx, a) => H.navigate(ctx, a),
  go_back: (ctx, a) => H.go_back(ctx, a),
  go_forward: (ctx, a) => H.go_forward(ctx, a),
  reload: (ctx, a) => H.reload(ctx, a),
  snapshot: (ctx, a) => H.snapshot(ctx, a),
  page_text: (ctx, a) => H.page_text(ctx, a),
  page_html: (ctx, a) => H.page_html(ctx, a),
  query: (ctx, a) => H.query(ctx, a),
  page_info: (ctx, a) => H.page_info(ctx, a),
  console_logs: (ctx, a) => H.console_logs(ctx, a),
  page_errors: (ctx, a) => H.page_errors(ctx, a),
  screenshot: (ctx, a) => H.screenshot(ctx, a),
  screenshot_annotated: (ctx, a) => H.screenshot_annotated(ctx, a),
  export_pdf: (ctx, a) => H.export_pdf(ctx, a),
  click: (ctx, a) => H.click(ctx, a),
  hover: (ctx, a) => H.hover(ctx, a),
  type: (ctx, a) => H.type(ctx, a),
  fill_form: (ctx, a) => H.fill_form(ctx, a),
  select_option: (ctx, a) => H.select_option(ctx, a),
  set_checked: (ctx, a) => H.set_checked(ctx, a),
  scroll: (ctx, a) => H.scroll(ctx, a),
  drag: (ctx, a) => H.drag(ctx, a),
  press_key: (ctx, a) => H.press_key(ctx, a),
  focus: (ctx, a) => H.focus(ctx, a),
  clipboard_read: (ctx) => H.clipboard_read(ctx),
  clipboard_write: (ctx, a) => H.clipboard_write(ctx, a),
  clipboard_copy_from: (ctx, a) => H.clipboard_copy_from(ctx, a),
  clipboard_paste_to: (ctx, a) => H.clipboard_paste_to(ctx, a),
  wait_for: (ctx, a) => H.wait_for(ctx, a),
  sleep: (ctx, a) => H.sleep(ctx, a),
  evaluate_js: (ctx, a) => H.evaluate_js(ctx, a),
  cookies_list: (ctx, a) => H.cookies_list(ctx, a),
  cookies_set: (ctx, a) => H.cookies_set(ctx, a),
  cookies_clear: (ctx, a) => H.cookies_clear(ctx, a),
  storage_get: (ctx, a) => H.storage_get(ctx, a),
  storage_set: (ctx, a) => H.storage_set(ctx, a),
  net_capture_start: (ctx, a) => H.net_capture_start(ctx, a),
  net_capture_stop: (ctx, a) => H.net_capture_stop(ctx, a),
  net_capture_get: (ctx, a) => H.net_capture_get(ctx, a),
  net_block: (ctx, a) => H.net_block(ctx, a),
  upload_file: (ctx, a) => H.upload_file(ctx, a),
  upload_files: (ctx, a) => H.upload_files(ctx, a),
  drag_drop_files: (ctx, a) => H.drag_drop_files(ctx, a),
  downloads_list: (ctx, a) => H.downloads_list(ctx, a),
};

function isScreenshotResult(value: unknown): value is { base64: string; mimeType: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.base64 === "string" && typeof v.mimeType === "string";
}

async function main(): Promise<void> {
  const config = loadConfig();
  const hub = new RemoraHub({
    port: config.port,
    token: config.token,
    agentId: config.agentId,
    ownerLabel: config.ownerLabel,
    extensionIds: config.extensionIds,
  });
  const ctx: Ctx = { hub };

  // Verify catalog and handlers agree, so a missing tool fails loudly at boot.
  for (const def of TOOL_DEFS) {
    if (!HANDLERS[def.name]) {
      throw new Error(`missing handler for tool: ${def.name}`);
    }
  }

  const server = new McpServer(
    { name: "remora", version: "0.1.0" },
    {
      instructions:
        "Remora shows the user live indicators while you use their Chrome. Call task_begin (with a short label) before your first browser action and task_end as soon as you finish, before your final answer.",
    },
  );
  for (const def of TOOL_DEFS) {
    const handler = HANDLERS[def.name];
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      async (args) => {
        try {
          const result = await handler(ctx, args as never);
          if (isScreenshotResult(result)) {
            return {
              content: [
                { type: "image" as const, data: result.base64, mimeType: result.mimeType },
                { type: "text" as const, text: JSON.stringify({ ...result, base64: "<omitted>" }) },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  await hub.start();
  if (config.ignoredEnvToken) {
    console.error("[remora] REMORA_TOKEN is no longer used and was ignored; you can remove it from the MCP config");
  }
  console.error(`[remora] MCP server up; registered ${TOOL_DEFS.length} tools`);

  const shutdown = async () => {
    await hub.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The MCP client closing stdin is the only "session over" signal we get.
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[remora] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
