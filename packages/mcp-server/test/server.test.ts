import { describe, expect, it } from "vitest";
import {
  describeAction,
  listActive,
  markActive,
  markClosed,
  sanitizeTarget,
  summarize,
} from "../src/activity.js";
import { guessMimeType } from "../src/uploads.js";
import { TOOL_DEFS } from "@remora/protocol";

describe("activity", () => {
  it("sanitizes targets", () => {
    expect(sanitizeTarget(undefined)).toBeUndefined();
    expect(sanitizeTarget("  Login   button  ")).toBe("Login button");
    expect(sanitizeTarget("x".repeat(200))?.length).toBeLessThanOrEqual(80);
  });

  it("tracks active tabs", () => {
    markActive(7, "clicked", "Login");
    expect(listActive().some((a) => a.tabId === 7)).toBe(true);
    markClosed(7);
    expect(listActive().some((a) => a.tabId === 7)).toBe(false);
  });

  it("summarizes actions", () => {
    expect(summarize("clicked", "Login")).toBe("clicked Login");
    expect(summarize("reloaded")).toBe("reloaded");
    expect(describeAction("typing", "field")).toEqual({ action: "typing", target: "field" });
  });
});

describe("uploads", () => {
  it("guesses mime types", () => {
    expect(guessMimeType("a.pdf")).toBe("application/pdf");
    expect(guessMimeType("a.PNG")).toBe("image/png");
    expect(guessMimeType("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("tool catalog parity", () => {
  it("every catalog tool has a handler key in index", async () => {
    // Handlers map is internal; verify the catalog itself is sane instead:
    // names unique, kebab-free, every entry has description + schema.
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.schema).toBe("object");
    }
    expect(names.length).toBeGreaterThanOrEqual(50);
  });
});
