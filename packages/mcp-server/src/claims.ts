/**
 * Tab claims: coordination between concurrent agent sessions.
 *
 * Every MCP process gets a stable agent id; any session may claim a tab for
 * exclusive use. Mutating tools fast-fail with TAB_CLAIMED when the caller's
 * id does not match the recorded claim, while read-only tools always pass.
 * Claims live in the primary hub (the process that owns the port) so every
 * attached peer enforces the same view; peers cache claims from broadcasts
 * for their read-path enrichment (`tabs_list`, `remora_status`).
 */

export interface TabClaim {
  tabId: number;
  /** Agent id that owns the claim. */
  agentId: string;
  /** Human label of the owner, e.g. `ZCode abc123`. */
  ownerLabel?: string;
  /** Short note the owner left, e.g. what it is doing. */
  note?: string;
  claimedAt: number;
}

/** Result of asking whether a caller may mutate a tab. */
export type ClaimVerdict =
  | { allowed: true }
  | { allowed: false; claim: TabClaim };

export interface ClaimSnapshot {
  tabId: number;
  agentId: string;
  ownerLabel?: string;
  note?: string;
  claimedAt: number;
}

export class ClaimStore {
  private claims = new Map<number, TabClaim>();

  claim(tabId: number, agentId: string, ownerLabel?: string, note?: string): TabClaim {
    const existing = this.claims.get(tabId);
    if (existing && existing.agentId !== agentId) {
      throw new Error("claimed");
    }
    const claim: TabClaim = {
      tabId,
      agentId,
      ownerLabel: ownerLabel ?? existing?.ownerLabel,
      note: note ?? existing?.note,
      claimedAt: existing?.claimedAt ?? Date.now(),
    };
    this.claims.set(tabId, claim);
    return claim;
  }

  release(tabId: number, agentId: string): boolean {
    const existing = this.claims.get(tabId);
    if (!existing) return false;
    if (existing.agentId !== agentId) throw new Error("claimed");
    this.claims.delete(tabId);
    return true;
  }

  /** Drop claims for tabs that no longer exist. Returns the dropped ids. */
  prune(knownTabIds: Set<number> | number[]): number[] {
    const known = knownTabIds instanceof Set ? knownTabIds : new Set(knownTabIds);
    const dropped: number[] = [];
    for (const tabId of this.claims.keys()) {
      if (!known.has(tabId)) {
        this.claims.delete(tabId);
        dropped.push(tabId);
      }
    }
    return dropped;
  }

  remove(tabId: number): void {
    this.claims.delete(tabId);
  }

  clearMine(agentId: string): number[] {
    const released: number[] = [];
    for (const [tabId, claim] of this.claims) {
      if (claim.agentId === agentId) {
        this.claims.delete(tabId);
        released.push(tabId);
      }
    }
    return released;
  }

  get(tabId: number): TabClaim | undefined {
    return this.claims.get(tabId);
  }

  check(tabId: number | undefined, agentId: string): ClaimVerdict {
    if (tabId === undefined) return { allowed: true };
    const claim = this.claims.get(tabId);
    if (!claim || claim.agentId === agentId) return { allowed: true };
    return { allowed: false, claim };
  }

  list(): TabClaim[] {
    return [...this.claims.values()].sort((a, b) => a.claimedAt - b.claimedAt);
  }

  snapshot(): ClaimSnapshot[] {
    return this.list().map((c) => ({ ...c }));
  }

  applySnapshot(entries: ClaimSnapshot[]): void {
    this.claims.clear();
    for (const e of entries) {
      if (typeof e.tabId === "number" && typeof e.agentId === "string") {
        this.claims.set(e.tabId, { ...e });
      }
    }
  }
}
