import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_IDLE_TIMEOUT_MS, TaskTracker, type TaskEnded } from "../src/tasks.js";

describe("TaskTracker", () => {
  let ended: TaskEnded[];
  let tracker: TaskTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    ended = [];
    tracker = new TaskTracker((e) => ended.push(e));
  });
  afterEach(() => vi.useRealTimers());

  it("starts implicitly on the first touch and counts steps", () => {
    expect(tracker.active).toBe(false);
    expect(tracker.touch(1).step).toBe(1);
    expect(tracker.touch(2).step).toBe(2);
    expect(tracker.active).toBe(true);
  });

  it("end() reports steps, duration and every touched tab", () => {
    tracker.begin("  Cari   headset ");
    tracker.touch(1);
    tracker.touch(2);
    vi.advanceTimersByTime(5000);
    const e = tracker.end("done");
    expect(e).toMatchObject({ label: "Cari headset", outcome: "done", steps: 2, durationMs: 5000 });
    expect(e?.tabIds.sort()).toEqual([1, 2]);
    expect(ended).toHaveLength(1);
    expect(tracker.active).toBe(false);
  });

  it("end() without a running task is a no-op", () => {
    expect(tracker.end()).toBeNull();
    expect(ended).toHaveLength(0);
  });

  it("begin() closes a task that is still running", () => {
    tracker.begin("a");
    tracker.touch(1);
    tracker.begin("b");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.label).toBe("a");
    expect(tracker.active).toBe(true);
  });

  it("times out after the idle window without a tool call", () => {
    tracker.touch(1);
    vi.advanceTimersByTime(TASK_IDLE_TIMEOUT_MS - 1);
    expect(ended).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ended[0]?.outcome).toBe("timeout");
  });

  it("a tool call resets the idle window", () => {
    tracker.touch(1);
    vi.advanceTimersByTime(TASK_IDLE_TIMEOUT_MS - 1000);
    tracker.touch(1);
    vi.advanceTimersByTime(TASK_IDLE_TIMEOUT_MS - 1000);
    expect(ended).toHaveLength(0);
  });
});
