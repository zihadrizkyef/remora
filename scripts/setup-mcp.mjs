#!/usr/bin/env node
/**
 * Daftarkan Remora ke MCP client yang ada di mesin ini memakai path checkout
 * ini sendiri, jadi config selalu benar walau repo ada di drive/folder lain
 * (D:\..., C:\Users\..., /home/...).
 *
 *   npm run setup:mcp                # semua client yang terdeteksi
 *   npm run setup:mcp -- --print     # hanya cetak JSON-nya
 *   npm run setup:mcp -- --dry-run   # lihat hasil tanpa menulis
 *   npm run setup:mcp -- --port 47300
 *   npm run setup:mcp -- --all       # buat file walau app-nya belum pernah jalan
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
// Forward slashes read the same to node on Windows and keep the JSON copy-pasteable.
const ENTRY = join(REPO, "packages", "mcp-server", "dist", "index.js").replace(/\\/g, "/");
const DEFAULT_PORT = 47291;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const port = Number(argv[argv.indexOf("--port") + 1]) > 0 ? Number(argv[argv.indexOf("--port") + 1]) : DEFAULT_PORT;
const DRY = has("--dry-run");
const ALL = has("--all");

function mcpServerEntry() {
  return {
    command: "node",
    args: [ENTRY],
    ...(port === DEFAULT_PORT ? {} : { env: { REMORA_PORT: String(port) } }),
  };
}

function configJson() {
  return { mcpServers: { remora: mcpServerEntry() } };
}

/** Each client stores the same `{ command, args }` under a different key path. */
function targets() {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const list = [
    { name: "Claude Desktop", path: join(appData, "Claude", "claude_desktop_config.json"), keys: ["mcpServers"] },
    { name: "ZCode", path: join(home, ".zcode", "cli", "config.json"), keys: ["mcp", "servers"] },
    { name: "Cursor", path: join(home, ".cursor", "mcp.json"), keys: ["mcpServers"] },
    { name: "Claude Code", path: join(home, ".claude.json"), keys: ["mcpServers"] },
  ];
  if (platform() === "darwin") {
    list[0] = {
      name: "Claude Desktop",
      path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      keys: ["mcpServers"],
    };
  } else if (platform() !== "win32") {
    list[0] = {
      name: "Claude Desktop",
      path: join(home, ".config", "Claude", "claude_desktop_config.json"),
      keys: ["mcpServers"],
    };
  }
  return list;
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { __unparsable: true };
  }
}

/** Set `value` at `keys` inside `obj`, creating intermediate objects. */
function setDeep(obj, keys, value) {
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return obj;
}

function getDeep(obj, keys) {
  let node = obj;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[key];
  }
  return node;
}

function install(target) {
  const exists = existsSync(target.path);
  if (!exists && !ALL) return { status: "skip", reason: "client belum pernah jalan" };

  const current = readJson(target.path);
  if (current.__unparsable) {
    return { status: "skip", reason: "JSON lama tidak valid, perbaiki manual" };
  }
  const slot = [...target.keys, "remora"];
  const before = JSON.stringify(getDeep(current, slot));
  const next = setDeep(current, slot, mcpServerEntry());
  const after = JSON.stringify(getDeep(next, slot));
  const body = `${JSON.stringify(next, null, 2)}\n`;

  if (exists && before === after) return { status: "same" };
  if (DRY) return { status: "would-write" };

  mkdirSync(dirname(target.path), { recursive: true });
  if (exists) copyFileSync(target.path, `${target.path}.bak`);
  writeFileSync(target.path, body, "utf8");
  return { status: "written" };
}

function main() {
  if (has("--print")) {
    process.stdout.write(`${JSON.stringify(configJson(), null, 2)}\n`);
    return;
  }
  if (!existsSync(ENTRY)) {
    console.error(`MCP entry belum ada: ${ENTRY}\nJalankan "npm run build" dulu.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Remora repo : ${REPO}`);
  console.log(`MCP entry   : ${ENTRY}`);
  console.log(`Port        : ${port}${DRY ? "  (dry run)" : ""}\n`);

  for (const target of targets()) {
    const res = install(target);
    const label = target.name.padEnd(15);
    if (res.status === "written") console.log(`✓ ${label} ${target.path}  (backup .bak)`);
    else if (res.status === "would-write") console.log(`~ ${label} ${target.path}  akan ditulis`);
    else if (res.status === "same") console.log(`= ${label} ${target.path}  sudah benar`);
    else console.log(`- ${label} ${target.path}  dilewati: ${res.reason}`);
  }

  console.log("\nRestart MCP client (Claude Desktop / ZCode / Cursor), lalu cek popup Remora jadi hijau.");
  console.log("Pindah folder repo? Jalankan ulang perintah ini di lokasi baru.");
}

main();
