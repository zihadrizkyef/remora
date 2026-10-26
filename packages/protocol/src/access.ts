/**
 * Tab access rules: an agent session may only touch tabs inside the Chrome
 * tab group it created. Pure functions so the extension (enforcement) and the
 * MCP server (defense in depth) share one rulebook and vitest can cover it.
 */

/** `chrome.tabGroups.TAB_GROUP_ID_NONE`. */
export const TAB_GROUP_NONE = -1;

export const OUT_OF_GROUP_MESSAGE =
  "tab di luar grup Remora milik sesi ini; buat tab dengan tab_create";

export const NO_GROUP_TAB_MESSAGE =
  "sesi ini belum punya tab di grup Remora; panggil tab_create dulu";

/** A tab group created by Remora for one agent session. */
export interface OwnedGroup {
  groupId: number;
  agentId: string;
  createdAt: number;
  label?: string;
  /** Hostnames the group's tabs have visited (scopes cookies/downloads). */
  hosts: string[];
  /** Last tab this session addressed; implicit calls resolve here first. */
  workingTabId?: number;
  /** `net_block` patterns, applied to this group's tabs only. */
  blockPatterns?: string[];
}

/** The slice of `chrome.tabs.Tab` the rules need. */
export interface TabRef {
  id: number;
  groupId: number;
  windowId: number;
  active?: boolean;
  lastAccessed?: number;
}

export type AccessResult =
  | { ok: true; tabId: number }
  | { ok: false; code: "OUT_OF_GROUP"; message: string };

export function groupOf(groups: readonly OwnedGroup[], agentId: string): OwnedGroup | undefined {
  return groups.find((g) => g.agentId === agentId);
}

export function ownerOf(groups: readonly OwnedGroup[], groupId: number): string | undefined {
  if (groupId === TAB_GROUP_NONE) return undefined;
  return groups.find((g) => g.groupId === groupId)?.agentId;
}

/** True only when the tab sits in a group this agent owns. */
export function isTabAllowed(
  tab: Pick<TabRef, "groupId"> | undefined,
  agentId: string,
  groups: readonly OwnedGroup[],
): boolean {
  if (!tab || !agentId) return false;
  return ownerOf(groups, tab.groupId) === agentId;
}

/** Explicit tabId check. A missing tab answers like a foreign one: no existence oracle. */
export function checkTab(
  tab: TabRef | undefined,
  agentId: string,
  groups: readonly OwnedGroup[],
): AccessResult {
  if (tab && isTabAllowed(tab, agentId, groups)) return { ok: true, tabId: tab.id };
  return { ok: false, code: "OUT_OF_GROUP", message: OUT_OF_GROUP_MESSAGE };
}

/**
 * Resolve a call without tabId. Never the window's active tab: the working
 * tab if it is still in the group, else the group's active tab, else the
 * group tab used most recently.
 */
export function resolveImplicitTab(
  tabs: readonly TabRef[],
  agentId: string,
  groups: readonly OwnedGroup[],
): AccessResult {
  const group = groupOf(groups, agentId);
  const mine = group ? tabs.filter((t) => t.groupId === group.groupId) : [];
  if (mine.length === 0) {
    return { ok: false, code: "OUT_OF_GROUP", message: NO_GROUP_TAB_MESSAGE };
  }
  const working = mine.find((t) => t.id === group?.workingTabId);
  if (working) return { ok: true, tabId: working.id };
  const active = mine.find((t) => t.active);
  if (active) return { ok: true, tabId: active.id };
  const recent = [...mine].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]!;
  return { ok: true, tabId: recent.id };
}

/** Only tabs of this session's group, for `tabs_list`. Everything else stays hidden. */
export function visibleTabs<T extends Pick<TabRef, "groupId">>(
  tabs: readonly T[],
  agentId: string,
  groups: readonly OwnedGroup[],
): { visible: T[]; hidden: number } {
  const visible = tabs.filter((t) => isTabAllowed(t, agentId, groups));
  return { visible, hidden: tabs.length - visible.length };
}

/**
 * A tab opened from a grouped tab (target=_blank, window.open) joins the
 * opener's group. Returns the group to join, or undefined to leave it alone.
 * Grouping only works within one window, and a tab the user already placed
 * in a group is never moved.
 */
export function groupForNewTab(
  tab: { groupId: number; windowId: number; openerTabId?: number },
  opener: TabRef | undefined,
  groups: readonly OwnedGroup[],
): number | undefined {
  if (tab.groupId !== TAB_GROUP_NONE) return undefined;
  if (tab.openerTabId === undefined || !opener || opener.id !== tab.openerTabId) return undefined;
  if (opener.windowId !== tab.windowId) return undefined;
  return ownerOf(groups, opener.groupId) !== undefined ? opener.groupId : undefined;
}

/** Drop groups Chrome no longer has (user closed/ungrouped them, browser restarted). */
export function pruneGroups(groups: readonly OwnedGroup[], liveGroupIds: Iterable<number>): OwnedGroup[] {
  const live = new Set(liveGroupIds);
  return groups.filter((g) => live.has(g.groupId));
}

/**
 * Clamp a move target into the group's contiguous index range: Chrome
 * ungroups a tab moved outside it, which would silently revoke access.
 */
export function clampIndexToGroup(index: number, groupIndices: readonly number[]): number {
  if (groupIndices.length === 0) return index;
  const lo = Math.min(...groupIndices);
  const hi = Math.max(...groupIndices);
  if (index < 0) return hi;
  return Math.min(Math.max(index, lo), hi);
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Cookie/storage scope: the URL's host must equal a host the group visited, or be a parent domain of one. */
export function isUrlInScope(url: string | undefined, hosts: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return hosts.some((h) => h === host || h.endsWith(`.${host}`));
}

/** Downloads are scoped to the session's lifetime and its hosts. */
export function isDownloadInScope(
  item: { startTime?: string; referrer?: string; url?: string; finalUrl?: string },
  group: Pick<OwnedGroup, "createdAt" | "hosts">,
): boolean {
  const started = item.startTime ? Date.parse(item.startTime) : NaN;
  if (!Number.isFinite(started) || started < group.createdAt) return false;
  return [item.referrer, item.finalUrl, item.url].some((u) => {
    const h = hostOf(u);
    return h !== undefined && group.hosts.includes(h);
  });
}

/** Group visual state shown through the chip colour/title. */
export type GroupState = "ready" | "running" | "done" | "timeout" | "aborted";

export const GROUP_COLOR: Record<GroupState, "grey" | "cyan" | "green" | "orange"> = {
  ready: "grey",
  running: "cyan",
  done: "green",
  timeout: "orange",
  aborted: "orange",
};

export function groupTitle(state: GroupState, label?: string, step?: number): string {
  const name = label ? (label.length > 32 ? label.slice(0, 31) + "…" : label) : undefined;
  switch (state) {
    case "ready":
      return "🤖 Remora · siap";
    case "running":
      return `🤖 Remora · ${name ?? "bekerja"}${step ? ` · langkah ${step}` : ""}`;
    case "done":
      return `🤖 Remora · ${name ? `${name} · ` : ""}selesai ✓`;
    case "timeout":
      return "🤖 Remora · berhenti tanpa sinyal";
    case "aborted":
      return "🤖 Remora · sesi ditutup";
  }
}
