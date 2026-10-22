import { describe, expect, it } from "vitest";
import {
  TOOL_DEFS,
  TOOL_NAMES,
  getToolDef,
  parseWireFrame,
  validateMethodParams,
} from "../src/index.js";

describe("parseWireFrame", () => {
  it("parses a request frame", () => {
    const f = parseWireFrame(JSON.stringify({ id: "1", method: "snapshot", params: {} }));
    expect(f.kind).toBe("request");
    if (f.kind === "request") expect(f.value.method).toBe("snapshot");
  });

  it("parses a response frame", () => {
    const f = parseWireFrame(JSON.stringify({ id: "1", ok: true, result: {} }));
    expect(f.kind).toBe("response");
  });

  it("parses an event frame", () => {
    const f = parseWireFrame(JSON.stringify({ event: "tab_closed", payload: { tabId: 1 } }));
    expect(f.kind).toBe("event");
  });

  it("parses a notification frame", () => {
    const f = parseWireFrame(
      JSON.stringify({ notification: "activity.show", payload: { tabId: 1, action: "click" } }),
    );
    expect(f.kind).toBe("notification");
  });

  it("rejects unknown frames", () => {
    expect(() => parseWireFrame(JSON.stringify({ nope: 1 }))).toThrow();
    expect(() => parseWireFrame("not json")).toThrow();
  });
});

describe("validateMethodParams", () => {
  it("accepts valid snapshot params", () => {
    expect(validateMethodParams("snapshot", { tabId: 3 })).toEqual({ ok: true });
  });

  it("rejects unknown methods", () => {
    const r = validateMethodParams("nope.nope", {});
    expect(r.ok).toBe(false);
  });

  it("rejects invalid params", () => {
    const r = validateMethodParams("snapshot", { tabId: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("tool catalog", () => {
  it("has unique tool names", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("has activity labels for every tool", () => {
    for (const t of TOOL_DEFS) {
      expect(t.activity.length).toBeGreaterThan(0);
    }
  });

  it("resolves tools by name", () => {
    expect(getToolDef("snapshot")?.name).toBe("snapshot");
    expect(getToolDef("upload_file")?.name).toBe("upload_file");
    expect(getToolDef("missing")).toBeUndefined();
  });

  it("covers the full feature list", () => {
    const names = new Set(TOOL_NAMES);
    for (const n of [
      "remora_status",
      "tabs_list",
      "tab_create",
      "navigate",
      "snapshot",
      "screenshot",
      "screenshot_annotated",
      "click",
      "type",
      "fill_form",
      "clipboard_paste_to",
      "wait_for",
      "evaluate_js",
      "cookies_list",
      "storage_get",
      "net_capture_start",
      "upload_file",
      "upload_files",
      "drag_drop_files",
      "downloads_list",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
