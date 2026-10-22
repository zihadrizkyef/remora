/**
 * Content-script: console + error capture ring buffers.
 * Installed once per document; read by the console.logs / page.errors methods.
 */

export interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
  url: string;
}

const consoleBuffer: ConsoleEntry[] = [];
const errorBuffer: ConsoleEntry[] = [];
const MAX = 500;
let installed = false;

function push(buf: ConsoleEntry[], entry: ConsoleEntry): void {
  buf.push(entry);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

function fmt(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function installCapture(): void {
  if (installed) return;
  installed = true;
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(consoleBuffer, {
        level,
        text: args.map(fmt).join(" ").slice(0, 2000),
        ts: Date.now(),
        url: location.href,
      });
      orig(...args);
    };
  }
  window.addEventListener("error", (ev) => {
    push(errorBuffer, {
      level: "error",
      text: `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`.slice(0, 2000),
      ts: Date.now(),
      url: location.href,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    push(errorBuffer, {
      level: "error",
      text: `unhandledrejection: ${fmt(ev.reason)}`.slice(0, 2000),
      ts: Date.now(),
      url: location.href,
    });
  });
}

export function readConsole(level: string, limit: number): ConsoleEntry[] {
  const entries = level === "all" ? consoleBuffer : consoleBuffer.filter((e) => e.level === level);
  return entries.slice(-limit);
}

export function readErrors(limit: number): ConsoleEntry[] {
  return errorBuffer.slice(-limit);
}
