/**
 * Task lifecycle for one MCP session (one agent).
 *
 * A task starts at `task_begin` or implicitly at the first tab-touching tool,
 * and ends at `task_end`, at the idle watchdog, or when the session closes.
 * The extension keeps its indicators lit for exactly that span.
 */

export type TaskOutcome = "done" | "timeout" | "aborted";

export interface TaskSnapshot {
  label?: string;
  startedAt: number;
  step: number;
}

export interface TaskEnded {
  label?: string;
  outcome: TaskOutcome;
  steps: number;
  durationMs: number;
  tabIds: number[];
}

/** No tool call for this long means the agent never signalled completion. */
export const TASK_IDLE_TIMEOUT_MS = 90_000;

interface Running {
  label?: string;
  startedAt: number;
  steps: number;
  tabs: Set<number>;
}

export class TaskTracker {
  private running: Running | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onEnd: (ended: TaskEnded) => void,
    private readonly idleMs = TASK_IDLE_TIMEOUT_MS,
  ) {}

  get active(): boolean {
    return this.running !== null;
  }

  /** Start a labelled task; a task still running is closed as done first. */
  begin(label?: string): TaskSnapshot {
    if (this.running) this.finish("done");
    this.running = { label: clean(label), startedAt: Date.now(), steps: 0, tabs: new Set() };
    this.arm();
    return this.snapshot(this.running);
  }

  /** Record one tab-touching tool call; starts an unlabelled task if none runs. */
  touch(tabId: number): TaskSnapshot {
    if (!this.running) this.running = { startedAt: Date.now(), steps: 0, tabs: new Set() };
    this.running.steps += 1;
    this.running.tabs.add(tabId);
    this.arm();
    return this.snapshot(this.running);
  }

  /** End the running task; returns null when none was running. */
  end(outcome: TaskOutcome = "done"): TaskEnded | null {
    return this.finish(outcome);
  }

  private finish(outcome: TaskOutcome): TaskEnded | null {
    const r = this.running;
    if (!r) return null;
    this.running = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ended: TaskEnded = {
      label: r.label,
      outcome,
      steps: r.steps,
      durationMs: Date.now() - r.startedAt,
      tabIds: [...r.tabs],
    };
    this.onEnd(ended);
    return ended;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish("timeout"), this.idleMs);
    this.timer.unref?.();
  }

  private snapshot(r: Running): TaskSnapshot {
    return { label: r.label, startedAt: r.startedAt, step: r.steps };
  }
}

function clean(label: string | undefined): string | undefined {
  const t = label?.replace(/\s+/g, " ").trim();
  return t ? (t.length > 60 ? t.slice(0, 59) + "…" : t) : undefined;
}
