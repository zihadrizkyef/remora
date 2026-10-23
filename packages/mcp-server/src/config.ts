import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_WS_PORT } from "@remora/protocol";

export interface RemoraConfig {
  port: number;
  token: string;
  configPath: string;
  /** True when the token was freshly generated on this run. */
  freshToken: boolean;
  /** Stable id for this MCP process (claim owner). */
  agentId: string;
  /** Short human label shown to other agents on claimed tabs. */
  ownerLabel: string;
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
 * Resolve port + auth token. Precedence: env vars > config file > generate.
 * A generated token is persisted so the extension pairing survives restarts.
 *
 * Each MCP *process* gets its own agent id: explicit REMORA_AGENT_ID wins,
 * else a fresh random one per process (never persisted — persisting it would
 * make every session share one identity and break claims). The owner label
 * defaults to the client name when known (REMORA_CLIENT, e.g. `ZCode`).
 */
export function loadConfig(): RemoraConfig {
  const dir = configDir();
  const configPath = join(dir, "config.json");
  const stored = readJsonFile(configPath) ?? {};

  const portRaw = process.env.REMORA_PORT ?? stored.port;
  const port = Number(portRaw) > 0 ? Number(portRaw) : DEFAULT_WS_PORT;

  let token = typeof process.env.REMORA_TOKEN === "string" && process.env.REMORA_TOKEN.length >= 16
    ? process.env.REMORA_TOKEN
    : typeof stored.token === "string" && stored.token.length >= 16
      ? stored.token
      : null;

  let freshToken = false;
  const agentId = typeof process.env.REMORA_AGENT_ID === "string" && process.env.REMORA_AGENT_ID
    ? process.env.REMORA_AGENT_ID
    : randomBytes(6).toString("hex");
  if (!token) {
    token = randomBytes(24).toString("hex");
    freshToken = true;
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port, token }, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  const client = typeof process.env.REMORA_CLIENT === "string" && process.env.REMORA_CLIENT
    ? process.env.REMORA_CLIENT
    : "agent";
  const ownerLabel = `${client} ${agentId.slice(-6)}`;

  return { port, token, configPath, freshToken, agentId, ownerLabel };
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
