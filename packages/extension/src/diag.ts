/**
 * Diagnostic ring buffer for the service worker.
 *
 * MV3 kills the worker without notice, so the log has to survive restarts:
 * entries are batched into chrome.storage.local and tagged with a per-worker
 * id. That id is what tells a connection flap (same worker, socket closed)
 * apart from a worker restart (new tag, socket lost with it).
 */

const STORE_KEY = "remoraDiag";
const META_KEY = "remoraDiagMeta";
const MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 300;

export interface DiagEntry {
  ts: number;
  worker: string;
  event: string;
  detail?: Record<string, unknown>;
}

export interface DiagMeta {
  worker: string;
  extensionId: string;
  version: string;
  incognito: boolean;
  startedAt: number;
}

export const workerTag = Math.random().toString(16).slice(2, 10);

const meta: DiagMeta = {
  worker: workerTag,
  extensionId: chrome.runtime.id,
  version: chrome.runtime.getManifest().version,
  incognito: chrome.extension.inIncognitoContext === true,
  startedAt: Date.now(),
};

let queue: DiagEntry[] = [];
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Record one line. Safe to call from anywhere; never throws. */
export function diag(event: string, detail?: Record<string, unknown>): void {
  queue.push({ ts: Date.now(), worker: workerTag, event, ...(detail ? { detail } : {}) });
  if (queue.length > 200) queue = queue.slice(-200);
  // Kept for chrome://extensions → service worker console while debugging.
  console.log(`[remora:diag] ${event}`, detail ?? "");
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (flushing) return;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;
  flushing = (async () => {
    try {
      const stored = await chrome.storage.local.get({ [STORE_KEY]: [] });
      const prev = Array.isArray(stored[STORE_KEY]) ? (stored[STORE_KEY] as DiagEntry[]) : [];
      const next = [...prev, ...batch]
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_ENTRIES);
      await chrome.storage.local.set({ [STORE_KEY]: next, [META_KEY]: meta });
    } catch {
      /* diagnostics must never break the worker */
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
    if (queue.length > 0) scheduleFlush();
  }
}

export async function readDiag(limit = MAX_ENTRIES): Promise<{ meta: DiagMeta | null; entries: DiagEntry[] }> {
  await flush();
  // A flush already in flight may still hold the last batch; wait it out.
  if (flushing) await flushing;
  await flush();
  const stored = await chrome.storage.local.get({ [STORE_KEY]: [], [META_KEY]: null });
  const entries = Array.isArray(stored[STORE_KEY]) ? (stored[STORE_KEY] as DiagEntry[]) : [];
  const storedMeta = (stored[META_KEY] as DiagMeta | null) ?? meta;
  return { meta: storedMeta, entries: entries.slice(-limit) };
}

export async function clearDiag(): Promise<void> {
  queue = [];
  await chrome.storage.local.set({ [STORE_KEY]: [], [META_KEY]: meta });
}
