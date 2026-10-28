import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_WS_PORT } from "@remora/protocol";

export interface RemoraConfig {
  port: number;
  token: string;
  configPath: string;
  /** Stable id for this MCP process (owner of its Remora tab group). */
  agentId: string;
  /** Short human label for logs and status. */
  ownerLabel: string;
  /** Optional allowlist of extension ids (config `extensionIds`). */
  extensionIds: string[];
  /** Set when the deprecated REMORA_TOKEN env var was present and ignored. */
  ignoredEnvToken: boolean;
}

function configDir(): string {
  const appData = process.env.APPDATA;
  if (process.platform === "win32" && appData) {
    return join(appData, "remora");
  }
  return join(homedir(), ".remora");
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve port + internal token. The token only authenticates MCP processes
 * to each other, so it lives in the config file alone (never env): every
 * client on this machine then shares it without any user setup. The
 * extension needs no token; the hub trusts its `chrome-extension://` origin.
 *
 * Each MCP *process* gets its own agent id: explicit REMORA_AGENT_ID wins,
 * else a fresh random one per process (never persisted — persisting it would
 * make every session share one identity and one tab group). The owner label
 * defaults to the client name when known (REMORA_CLIENT, e.g. `ZCode`).
 */
export function loadConfig(): RemoraConfig {
  const dir = configDir();
  const configPath = join(dir, "config.json");
  const stored = readJsonFile(configPath) ?? {};

  const portRaw = process.env.REMORA_PORT ?? stored.port;
  const port = Number(portRaw) > 0 ? Number(portRaw) : DEFAULT_WS_PORT;

  let token = typeof stored.token === "string" && stored.token.length >= 16 ? stored.token : null;

  const agentId = typeof process.env.REMORA_AGENT_ID === "string" && process.env.REMORA_AGENT_ID
    ? process.env.REMORA_AGENT_ID
    : randomBytes(6).toString("hex");
  if (!token) {
    token = randomBytes(24).toString("hex");
    mkdirSync(dir, { recursive: true });
    try {
      // `wx`: two clients starting together must end up sharing one token.
      writeFileSync(configPath, JSON.stringify({ ...stored, port, token }, null, 2) + "\n", {
        mode: 0o600,
        flag: Object.keys(stored).length === 0 ? "wx" : "w",
      });
    } catch {
      const raced = readJsonFile(configPath);
      if (typeof raced?.token === "string" && raced.token.length >= 16) token = raced.token;
    }
  }
  const extensionIds = Array.isArray(stored.extensionIds)
    ? stored.extensionIds.filter((id): id is string => typeof id === "string")
    : [];
  const client = typeof process.env.REMORA_CLIENT === "string" && process.env.REMORA_CLIENT
    ? process.env.REMORA_CLIENT
    : "agent";
  const ownerLabel = `${client} ${agentId.slice(-6)}`;

  return {
    port,
    token,
    configPath,
    agentId,
    ownerLabel,
    extensionIds,
    ignoredEnvToken: typeof process.env.REMORA_TOKEN === "string" && process.env.REMORA_TOKEN !== "",
  };
}

/** MCP client config snippet the popup offers as copy-paste. */
export function mcpConfigSnippet(serverEntry: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        remora: {
          command: "node",
          args: [serverEntry],
        },
      },
    },
    null,
    2,
  );
}
