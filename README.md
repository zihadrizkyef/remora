# Remora — agent Browser Bridge

AI agent (via MCP) bisa melihat dan mengendalikan Chrome kamu: tab,
navigasi, snapshot halaman, screenshot, klik/ketik, upload file tanpa
dialog Explorer, cookies/storage, dan network capture — semuanya lokal
(`127.0.0.1`, tanpa cloud).

```
[agent] --stdio--> [MCP server] --ws://127.0.0.1:47291--> [Chrome extension]
```

## Mulai Cepat

```bash
npm install && npm run build
```

1. `chrome://extensions` → Load unpacked → `packages/extension/dist/`.
2. Klik ikon Remora → **Regenerate** → **Copy MCP config JSON**.
3. Tempel ke MCP client (Claude Desktop / ZCode), restart client.
4. Popup → **Reconnect** → dot hijau.

Panduan lengkap: [`docs/INSTALL.md`](docs/INSTALL.md) ·
Daftar tools: [`docs/TOOLS.md`](docs/TOOLS.md) ·
Keamanan: [`docs/SECURITY.md`](docs/SECURITY.md) ·
Panduan kontributor: [`AGENTS.md`](AGENTS.md)

## Struktur

- `packages/protocol/` — kontrak wire + katalog tool (shared).
- `packages/mcp-server/` — MCP stdio + WebSocket hub + 54 tools.
- `packages/extension/` — extension MV3 (background, content, popup).
- `design/` — mockup UI (skill claude-design).
- `assets/icons/` — konsep + master ikon (skill create-icon).
- `docs/` — instalasi, tools, keamanan.

## Perintah

```bash
npm run build       # semua package → dist/
npm run typecheck   # tsc semua workspace
npm run test        # vitest (protocol + mcp-server)
```
