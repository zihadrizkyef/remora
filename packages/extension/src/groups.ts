/**
 * Remora tab groups: one Chrome tab group per agent session is that
 * session's access boundary. Ownership lives in chrome.storage.session so it
 * survives service-worker restarts but never a browser restart (group ids
 * change then, and a restored group must not silently regain an owner).
 */

import {
  GROUP_COLOR,
  TAB_GROUP_NONE,
  groupOf,
  groupTitle,
  hostOf,
  pruneGroups,
  type GroupState,
  type OwnedGroup,
  type TabRef,
} from "@remora/protocol";

const STORE_KEY = "remoraGroups";
const MAX_HOSTS = 50;
/** Chrome re-renders the tab strip on every title change; keep it calm. */
const TITLE_MIN_INTERVAL_MS = 3000;
const RESULT_MS = { done: 4000, timeout: 6000, aborted: 6000 } as const;

let cache: OwnedGroup[] | null = null;

export function toRef(tab: chrome.tabs.Tab): TabRef {
  return {
    id: tab.id ?? -1,
    groupId: tab.groupId ?? TAB_GROUP_NONE,
    windowId: tab.windowId,
    active: tab.active,
    lastAccessed: (tab as { lastAccessed?: number }).lastAccessed,
  };
}

export async function loadGroups(): Promise<OwnedGroup[]> {
  if (cache) return cache;
  const stored = await chrome.storage.session.get({ [STORE_KEY]: [] });
  const list = Array.isArray(stored[STORE_KEY]) ? (stored[STORE_KEY] as OwnedGroup[]) : [];
  const live = await chrome.tabGroups.query({});
  cache = pruneGroups(list, live.map((g) => g.id));
  if (cache.length !== list.length) await persist();
  return cache;
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({ [STORE_KEY]: cache ?? [] });
}

export async function updateGroups(fn: (groups: OwnedGroup[]) => OwnedGroup[]): Promise<void> {
  await loadGroups();
  cache = fn(cache ?? []);
  await persist();
}

export async function groupFor(agentId: string): Promise<OwnedGroup | undefined> {
  return groupOf(await loadGroups(), agentId);
}

export async function setWorkingTab(agentId: string, tabId: number): Promise<void> {
  const g = await groupFor(agentId);
  if (!g || g.workingTabId === tabId) return;
  await updateGroups((list) => list.map((x) => (x.agentId === agentId ? { ...x, workingTabId: tabId } : x)));
}

export async function rememberHost(groupId: number, url: string | undefined): Promise<void> {
  const host = hostOf(url);
  if (!host) return;
  const g = (await loadGroups()).find((x) => x.groupId === groupId);
  if (!g || g.hosts.includes(host)) return;
  await updateGroups((list) =>
    list.map((x) => (x.groupId === groupId ? { ...x, hosts: [...x.hosts, host].slice(-MAX_HOSTS) } : x)),
  );
}

export async function forgetGroup(groupId: number): Promise<void> {
  visuals.delete(groupId);
  if (!(await loadGroups()).some((g) => g.groupId === groupId)) return;
  await updateGroups((list) => list.filter((g) => g.groupId !== groupId));
}

/**
 * Open a tab inside the agent's group, creating the group on first use. The
 * group is bound to one window, so later tabs open there. A tab that cannot
 * be grouped is closed again rather than left as an unowned agent tab.
 */
export async function createGroupedTab(
  agentId: string,
  opts: { url?: string; active?: boolean; label?: string },
): Promise<chrome.tabs.Tab> {
  let g = await groupFor(agentId);
  let windowId: number | undefined;
  if (g) {
    windowId = (await chrome.tabGroups.get(g.groupId).catch(() => null))?.windowId;
    if (windowId === undefined) {
      await forgetGroup(g.groupId);
      g = undefined;
    }
  }
  if (windowId === undefined) {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
  }
  const tab = await chrome.tabs.create({ url: opts.url || undefined, active: opts.active !== false, windowId });
  try {
    if (g) {
      await chrome.tabs.group({ groupId: g.groupId, tabIds: tab.id! });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: tab.id!, createProperties: { windowId: tab.windowId } });
      const owned: OwnedGroup = { groupId, agentId, createdAt: Date.now(), label: opts.label, hosts: [] };
      await updateGroups((list) => [...list.filter((x) => x.agentId !== agentId), owned]);
      if (opts.label) showRunning(groupId, opts.label, 0);
      else paintNow(groupId, "ready");
    }
  } catch (err) {
    await chrome.tabs.remove(tab.id!).catch(() => undefined);
    throw err;
  }
  await setWorkingTab(agentId, tab.id!);
  return chrome.tabs.get(tab.id!);
}

// ---------------------------------------------------------------------------
// group chip: colour + title per task state
// ---------------------------------------------------------------------------

interface Visual {
  state: GroupState;
  label?: string;
  step?: number;
  lastPaint: number;
  pending?: ReturnType<typeof setTimeout>;
  revert?: ReturnType<typeof setTimeout>;
}

const visuals = new Map<number, Visual>();

function visual(groupId: number): Visual {
  let v = visuals.get(groupId);
  if (!v) visuals.set(groupId, (v = { state: "ready", lastPaint: 0 }));
  return v;
}

function paint(groupId: number): void {
  const v = visual(groupId);
  if (v.pending) clearTimeout(v.pending);
  v.pending = undefined;
  v.lastPaint = Date.now();
  void chrome.tabGroups
    .update(groupId, { title: groupTitle(v.state, v.label, v.step), color: GROUP_COLOR[v.state] })
    .catch(() => undefined);
}

function paintNow(groupId: number, state: GroupState, label?: string): void {
  const v = visual(groupId);
  if (v.revert) clearTimeout(v.revert);
  v.revert = undefined;
  v.state = state;
  if (label !== undefined) v.label = label;
  paint(groupId);
}

/** Running task: colour and label change at once, the step counter is throttled. */
export function showRunning(groupId: number, label: string | undefined, step: number): void {
  const v = visual(groupId);
  if (v.revert) clearTimeout(v.revert);
  v.revert = undefined;
  const changed = v.state !== "running" || v.label !== label;
  v.state = "running";
  v.label = label;
  v.step = step;
  const since = Date.now() - v.lastPaint;
  if (changed || since >= TITLE_MIN_INTERVAL_MS) paint(groupId);
  else if (!v.pending) v.pending = setTimeout(() => paint(groupId), TITLE_MIN_INTERVAL_MS - since);
}

/** Task over: show the result briefly, then go back to "siap". The group stays. */
export function showResult(groupId: number, outcome: "done" | "timeout" | "aborted", label?: string): void {
  paintNow(groupId, outcome, label);
  if (outcome === "aborted") return;
  const v = visual(groupId);
  v.revert = setTimeout(() => {
    v.revert = undefined;
    v.state = "ready";
    paint(groupId);
  }, RESULT_MS[outcome]);
}

/**
 * Session gone: revoke access immediately, keep the orange chip briefly so
 * the user sees why, then ungroup the tabs (they stay open as normal tabs).
 */
export async function releaseSession(agentId: string): Promise<number[]> {
  const g = await groupFor(agentId);
  if (!g) return [];
  const tabIds = (await chrome.tabs.query({ groupId: g.groupId })).map((t) => t.id!).filter((id) => id >= 0);
  await updateGroups((list) => list.filter((x) => x.agentId !== agentId));
  showResult(g.groupId, "aborted");
  setTimeout(() => {
    visuals.delete(g.groupId);
    void chrome.tabs
      .query({ groupId: g.groupId })
      .then((tabs) => {
        const ids = tabs.map((t) => t.id!).filter((id) => id >= 0);
        return ids.length > 0 ? chrome.tabs.ungroup(ids) : undefined;
      })
      .catch(() => undefined);
  }, RESULT_MS.aborted);
  return tabIds;
}
