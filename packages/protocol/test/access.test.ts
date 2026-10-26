import { describe, expect, it } from "vitest";
import {
  OUT_OF_GROUP_MESSAGE,
  TAB_GROUP_NONE,
  checkTab,
  clampIndexToGroup,
  groupForNewTab,
  groupTitle,
  isDownloadInScope,
  isTabAllowed,
  isUrlInScope,
  pruneGroups,
  resolveImplicitTab,
  visibleTabs,
  type OwnedGroup,
  type TabRef,
} from "../src/index.js";

const groups: OwnedGroup[] = [
  { groupId: 10, agentId: "a", createdAt: 1_000, hosts: ["shop.example"] },
  { groupId: 20, agentId: "b", createdAt: 1_000, hosts: [] },
];
const tab = (id: number, groupId: number, extra: Partial<TabRef> = {}): TabRef => ({
  id,
  groupId,
  windowId: 1,
  ...extra,
});

describe("isTabAllowed / checkTab", () => {
  it("allows only tabs in the session's own group", () => {
    expect(isTabAllowed(tab(1, 10), "a", groups)).toBe(true);
    expect(isTabAllowed(tab(1, 20), "a", groups)).toBe(false);
  });

  it("rejects a tab outside every group with OUT_OF_GROUP", () => {
    expect(checkTab(tab(5, TAB_GROUP_NONE), "a", groups)).toEqual({
      ok: false,
      code: "OUT_OF_GROUP",
      message: OUT_OF_GROUP_MESSAGE,
    });
  });

  it("rejects a tab in a user-made group Remora does not own", () => {
    expect(checkTab(tab(5, 99), "a", groups).ok).toBe(false);
  });

  it("answers a missing tab like a foreign one", () => {
    expect(checkTab(undefined, "a", groups)).toMatchObject({ ok: false, code: "OUT_OF_GROUP" });
  });

  it("dragging a tab out of the group revokes access at once", () => {
    const t = tab(3, 10);
    expect(checkTab(t, "a", groups).ok).toBe(true);
    t.groupId = TAB_GROUP_NONE;
    expect(checkTab(t, "a", groups).ok).toBe(false);
  });

  it("dragging a tab into the group grants access", () => {
    const t = tab(4, TAB_GROUP_NONE);
    expect(isTabAllowed(t, "a", groups)).toBe(false);
    t.groupId = 10;
    expect(isTabAllowed(t, "a", groups)).toBe(true);
  });

  it("closing the group (pruned by Chrome) revokes every tab in it", () => {
    const live = pruneGroups(groups, [20]);
    expect(isTabAllowed(tab(1, 10), "a", live)).toBe(false);
    expect(isTabAllowed(tab(2, 20), "b", live)).toBe(true);
  });
});

describe("resolveImplicitTab", () => {
  const tabs = [
    tab(1, TAB_GROUP_NONE, { active: true, lastAccessed: 900 }),
    tab(2, 10, { lastAccessed: 100 }),
    tab(3, 10, { lastAccessed: 500 }),
  ];

  it("never falls back to the window's active tab outside the group", () => {
    expect(resolveImplicitTab(tabs, "a", groups)).toEqual({ ok: true, tabId: 3 });
  });

  it("prefers the working tab while it is still in the group", () => {
    const g = [{ ...groups[0]!, workingTabId: 2 }, groups[1]!];
    expect(resolveImplicitTab(tabs, "a", g)).toEqual({ ok: true, tabId: 2 });
  });

  it("skips a working tab the user dragged out", () => {
    const g = [{ ...groups[0]!, workingTabId: 1 }, groups[1]!];
    expect(resolveImplicitTab(tabs, "a", g)).toEqual({ ok: true, tabId: 3 });
  });

  it("prefers the group's active tab over the most recent one", () => {
    const t = [...tabs, tab(4, 10, { active: true, lastAccessed: 1 })];
    expect(resolveImplicitTab(t, "a", groups)).toEqual({ ok: true, tabId: 4 });
  });

  it("asks for tab_create when the session has no group tab", () => {
    const r = resolveImplicitTab(tabs, "c", groups);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/tab_create/);
  });
});

describe("visibleTabs", () => {
  it("hides every tab outside the session group and only counts them", () => {
    const r = visibleTabs([tab(1, TAB_GROUP_NONE), tab(2, 10), tab(3, 20)], "a", groups);
    expect(r.visible.map((t) => t.id)).toEqual([2]);
    expect(r.hidden).toBe(2);
  });
});

describe("groupForNewTab", () => {
  it("a tab opened from a group tab joins that group", () => {
    const opener = tab(2, 10);
    expect(groupForNewTab({ groupId: TAB_GROUP_NONE, windowId: 1, openerTabId: 2 }, opener, groups)).toBe(10);
  });

  it("a tab opened from a user tab stays outside", () => {
    const opener = tab(1, TAB_GROUP_NONE);
    expect(groupForNewTab({ groupId: TAB_GROUP_NONE, windowId: 1, openerTabId: 1 }, opener, groups)).toBeUndefined();
  });

  it("a popup in another window is left alone", () => {
    const opener = tab(2, 10);
    expect(groupForNewTab({ groupId: TAB_GROUP_NONE, windowId: 2, openerTabId: 2 }, opener, groups)).toBeUndefined();
  });

  it("never moves a tab the user already grouped", () => {
    const opener = tab(2, 10);
    expect(groupForNewTab({ groupId: 99, windowId: 1, openerTabId: 2 }, opener, groups)).toBeUndefined();
  });
});

describe("scope helpers", () => {
  it("clamps a move into the group's index range", () => {
    expect(clampIndexToGroup(0, [4, 5, 6])).toBe(4);
    expect(clampIndexToGroup(9, [4, 5, 6])).toBe(6);
    expect(clampIndexToGroup(-1, [4, 5, 6])).toBe(6);
    expect(clampIndexToGroup(5, [4, 5, 6])).toBe(5);
  });

  it("scopes cookie URLs to group hosts and their parent domains", () => {
    expect(isUrlInScope("https://shop.example/cart", ["shop.example"])).toBe(true);
    expect(isUrlInScope("https://example/", ["shop.example"])).toBe(true);
    expect(isUrlInScope("https://bank.example/", ["shop.example"])).toBe(false);
    expect(isUrlInScope("chrome://settings", ["shop.example"])).toBe(false);
  });

  it("scopes downloads to the session lifetime and group hosts", () => {
    const g = { createdAt: Date.parse("2026-10-23T10:00:00Z"), hosts: ["shop.example"] };
    expect(isDownloadInScope({ startTime: "2026-10-23T10:05:00Z", referrer: "https://shop.example/x" }, g)).toBe(true);
    expect(isDownloadInScope({ startTime: "2026-10-23T09:00:00Z", referrer: "https://shop.example/x" }, g)).toBe(false);
    expect(isDownloadInScope({ startTime: "2026-10-23T10:05:00Z", referrer: "https://mail.example/" }, g)).toBe(false);
  });

  it("titles carry label and step", () => {
    expect(groupTitle("running", "Cari headset", 7)).toBe("🤖 Remora · Cari headset · langkah 7");
    expect(groupTitle("ready")).toBe("🤖 Remora · siap");
  });
});
