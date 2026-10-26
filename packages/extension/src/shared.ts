/**
 * Shared extension helpers: settings store + wire error factory.
 * Imported by background, content, and popup bundles.
 */

export interface RemoraSettings {
  port: number;
  token: string;
  jsEvalEnabled: boolean;
  netCaptureEnabled: boolean;
  blockedSites: string[];
}

export const DEFAULT_SETTINGS: RemoraSettings = {
  port: 47291,
  token: "",
  jsEvalEnabled: false,
  netCaptureEnabled: false,
  blockedSites: [],
};

export async function loadSettings(): Promise<RemoraSettings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    port: Number(stored.port) > 0 ? Number(stored.port) : DEFAULT_SETTINGS.port,
    token: typeof stored.token === "string" ? stored.token : "",
    jsEvalEnabled: stored.jsEvalEnabled === true,
    netCaptureEnabled: stored.netCaptureEnabled === true,
    blockedSites: Array.isArray(stored.blockedSites) ? stored.blockedSites : [],
  };
}

export async function saveSettings(patch: Partial<RemoraSettings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isSiteBlocked(url: string | undefined, blocked: string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return blocked.some((b) => origin === b || origin.endsWith(`.${b.replace(/^https?:\/\//, "")}`));
}

/** Wire error with a stable code (see protocol WireErrorCode). */
export function wireError(code: string, message: string): { __wireError: true; code: string; message: string } {
  return { __wireError: true, code, message };
}

export function isWireError(value: unknown): value is { __wireError: true; code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__wireError === true
  );
}
