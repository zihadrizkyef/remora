/**
 * Agent-activity tracking + sanitization.
 *
 * Every tool that touches a tab reports here. The hub forwards a sanitized
 * `activity.show` notification to the extension, which renders the in-page
 * pill, badge, and title prefix. Typed text must never leak into the pill.
 */

export interface ActiveTab {
  tabId: number;
  action: string;
  target?: string;
  ts: number;
}

const activeTabs = new Map<number, ActiveTab>();

/** Strip anything that could carry typed text or secrets. */
export function sanitizeTarget(target: string | undefined, maxLen = 80): string | undefined {
  if (!target) return undefined;
  const cleaned = target.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
}

/** Tool-facing label for the pill's action line, e.g. `click` + `Login button`. */
export function describeAction(activity: string, target?: string): { action: string; target?: string } {
  return { action: activity, target: sanitizeTarget(target) };
}

export function markActive(tabId: number, action: string, target?: string): ActiveTab {
  const entry: ActiveTab = { tabId, action, target: sanitizeTarget(target), ts: Date.now() };
  activeTabs.set(tabId, entry);
  return entry;
}

export function markClosed(tabId: number): void {
  activeTabs.delete(tabId);
}

export function listActive(): ActiveTab[] {
  return [...activeTabs.values()].sort((a, b) => b.ts - a.ts);
}

/** Friendly one-liner for tool results, e.g. `clicked "Login"`. */
export function summarize(activity: string, target?: string): string {
  const t = sanitizeTarget(target, 60);
  return t ? `${activity} ${t}` : activity;
}
