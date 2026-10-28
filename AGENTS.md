# AGENTS.md — Remora: Chrome Extension + MCP Bridge

Panduan kerja untuk semua agent (manusia maupun AI) yang berkontribusi di repo ini.

## 1. Ringkasan Proyek

Remora membuat agent AI (Claude Desktop, ZCode, dsb. via MCP) bisa mengakses dan
mengendalikan Google Chrome milik user: kelola tab, navigasi, baca halaman,
screenshot, klik/ketik, copy-paste, upload file, eksekusi JS, kelola
cookies/storage, dan capture network.

Nama "Remora" = ikan yang menempel pada hewan laut besar — extension ini
"menempel" pada Chrome dan memberi agent akses penuh yang aman.

## 2. Arsitektur: WebSocket Bridge

```
[Agent via MCP client] --stdio--> [MCP Server Remora (Node.js, localhost)]
                                              |
                                   ws://127.0.0.1:PORT/remora
                                   (server di MCP, cek Origin extension)
                                              |
[Chrome Extension MV3] <--WebSocket client (auto-reconnect + heartbeat)--+
  - background service worker: WS client, chrome.* API, badge, title prefix
  - content script per tab: snapshot AX, interaksi sintetis, file inject,
    pill indikator, highlight target
  - popup UI: status + alasan putus, config MCP, toggle, log aktivitas
```

Keputusan arsitektur (final, jangan diubah tanpa diskusi):

- **WebSocket bridge**, bukan Native Messaging (tanpa installer/registry) dan
  bukan CDP langsung (tanpa flag `--remote-debugging-port`).
- **Tanpa `chrome.debugger` sama sekali** — tidak ada banner "controlled".
  Semua interaksi via content-script synthesized events.
- Protokol WS: JSON `{ id, method, params }` → `{ id, ok, result?, error? }`,
  plus event push satu arah `{ event, payload }`
  (`agent_activity`, `tab_closed`, `navigated`).

## 3. Struktur Repo

```
remora/
  AGENTS.md
  package.json                 # npm workspaces
  tsconfig.base.json
  packages/
    protocol/                  # tipe + skema pesan WS + katalog tool (shared)
      src/messages.ts          # tipe WireRequest/WireResponse/WireEvent
      src/tools.ts             # definisi tool: nama, deskripsi, skema zod
      src/index.ts
    mcp-server/                # Node.js: MCP stdio + WS hub + implementasi tools
      src/index.ts             # entry: McpServer + register semua tools
      src/hub.ts               # WebSocket server, cek Origin/token peer, routing, retry
      src/activity.ts          # emit agent_activity + sanitasi
      src/uploads.ts           # baca file disk + chunking base64
      src/tools/*.ts           # implementasi per kelompok tool
    extension/                 # Chrome MV3 (TypeScript → esbuild → dist/)
      manifest.json
      icons/icon-{16,32,48,128}.png
      src/background.ts        # WS client, tab/window/cookies/downloads/net
      src/content.ts           # snapshot, interaksi, inject file, pill, highlight
      src/popup.html src/popup.ts src/popup.css
  design/                      # mockup HTML dari skill claude-design
  assets/icons/                # master SVG + 10 konsep dari skill create-icon
  docs/
    INSTALL.md                 # instalasi: load unpacked + config MCP JSON
    TOOLS.md                   # daftar seluruh MCP tools + contoh
    SECURITY.md                # model ancaman + toggle pengaman
```

## 4. Perintah

```bash
npm install            # install semua workspace
npm run build          # build protocol → mcp-server (tsc) + extension (esbuild) → dist/
npm run typecheck      # tsc --noEmit semua package
npm run test           # vitest (protocol + mcp-server unit)
npm run dev:mcp        # jalankan MCP server (stdio) untuk debugging
```

Load extension: `chrome://extensions` → Developer mode → Load unpacked →
`packages/extension/dist/`.

## 5. Konvensi Kode

- TypeScript strict di semua package; ESM (`"type": "module"`).
- Validasi semua input tool dengan **zod** di MCP server; validasi ulang pesan
  WS di kedua sisi (defense in depth ringan).
- Setiap tool yang menyentuh tab HARUS emit `agent_activity` (lihat §7).
- Error wire: `{ code, message }` dengan code stabil
  (`NO_TAB`, `NO_EXTENSION`, `TIMEOUT`, `NOT_ALLOWED`, `BAD_REF`,
  `OUT_OF_GROUP`, ...).
- Aturan akses tab = fungsi murni di `packages/protocol/src/access.ts`
  (`isTabAllowed`, `resolveImplicitTab`, `groupForNewTab`, …), dipakai
  extension (penegakan) dan MCP server (validasi ulang), diuji vitest.
- Jangan pernah log token auth atau isi ketikan user.
- Komentar kode: hanya untuk constraint yang tak terlihat dari kode
  (mis. trik React native setter, batas MV3). Tanpa atribusi.

## 6. Katalog MCP Tools (56, full — tanpa MVP)

- Koneksi: `remora_status` (lapor `agentId`, grup sesi ini, dan jumlah tab
  lain yang disembunyikan — tanpa url/title)
- Siklus tugas: `task_begin` (label singkat), `task_end` (selesai). Indikator
  menyala sampai `task_end` (lihat §7).
- Tab & window: `tabs_list` (hanya tab grup sesi), `tab_activate`,
  `tab_create` (membuat/mengisi grup sesi), `tab_close`, `tab_duplicate`
  (ikut grup), `tab_pin` (unpin saja), `tab_mute`, `tab_move` (di dalam
  grup, tanpa pindah window), `windows_list` (window grup saja)
- Isolasi: tiap sesi agent (`agentId` per proses MCP) punya satu Chrome Tab
  Group; SEMUA tool (baca maupun ubah) hanya boleh menyentuh tab di grup
  itu, selain itu `OUT_OF_GROUP`. Tool tanpa `tabId` resolve ke working tab
  di grup, bukan tab aktif window. Cookies/downloads/clipboard/net_block
  dibatasi ke grup. Mekanisme klaim lama (`tab_claim`/`tab_release`,
  `TAB_CLAIMED`) dihapus karena digantikan grup.
- Navigasi: `navigate`, `go_back`, `go_forward`, `reload`
- Persepsi: `snapshot`, `page_text`, `page_html`, `query`, `page_info`,
  `console_logs`, `page_errors`
- Visual: `screenshot`, `screenshot_annotated`, `export_pdf`
- Interaksi: `click`, `hover`, `type`, `fill_form`, `select_option`,
  `set_checked`, `scroll`, `drag`, `press_key`, `focus`
- Clipboard: `clipboard_read`, `clipboard_write`, `clipboard_copy_from`,
  `clipboard_paste_to`
- Tunggu: `wait_for`, `sleep`
- JS & storage: `evaluate_js` (gated), `cookies_list`, `cookies_set`,
  `cookies_clear`, `storage_get`, `storage_set`
- Network: `net_capture_start`, `net_capture_stop`, `net_capture_get`,
  `net_block`
- File: `upload_file`, `upload_files`, `drag_drop_files`, `downloads_list`

Detail tiap tool + contoh: `docs/TOOLS.md`. Menambah tool baru =
tambah skema di `protocol`, method WS, handler di extension, registrasi di MCP.

## 7. Indikator "Tab Dipakai Agent" (final: Tab Group + Pill + Badge + Favicon, info saja)

Penanda utama adalah **Chrome Tab Group** sesi: judul
`🤖 Remora · <label> · langkah N` (diperbarui paling cepat tiap 3 detik),
warna cyan = berjalan, green = selesai, orange = timeout/putus, grey = siap.
Grup TIDAK dilepas saat `task_end` — hanya warna/judul berubah, lalu kembali
"siap"; grup dilepas (ungroup, tab tetap terbuka) saat sesi MCP berakhir.
Mockup: `design/Remora Tab Group.html`.

Lapisan detail langkah, semuanya **non-interaktif** (tanpa tombol Stop/Pause):

1. **Pill melayang** (Shadow DOM, kanan-atas, `pointer-events:none`):
   dot teal 10px berdenyut + "Remora · agent aktif" + aksi terakhir.
   Teks kecil (11px, border 1px tipis). Dot memancarkan 2 gelombang
   radar (diameter 20vw = radius 10% lebar layar, border 2.5px teal,
   periode 1 detik, offset setengah detik) yang selalu terlihat.
   Dua baris: "Remora · agent bekerja — <label>" dan "langkah N · mm:ss ·
   aksi terakhir". Tidak memudar sendiri; menyala sejak tool pertama
   sampai tugas berakhir.
2. **Badge** merah bertuliskan "AI" pada ikon extension tab aktif
   + tooltip aksi terakhir.
3. **Prefix `🟢 [Agent] `** pada `document.title` selama tugas berjalan
   (MutationObserver).
4. **Favicon badge**: dot teal pada favicon situs (fallback lingkaran
   polos bila favicon cross-origin tanpa CORS); dikembalikan saat tugas berakhir.
5. **Highlight amber 1.2 detik** (outline 3px + glow) pada elemen target
   tiap aksi.
6. Isi ketikan user TIDAK BOLEH tampil di pill ("mengetik di …" saja).
7. Sumber data: notifikasi `activity.show { tabId, action, target, task }`
   dan `task.end { tabId, outcome, label, steps, durationMs }` dari MCP.

### Siklus tugas (mulai / berjalan / selesai / putus)

Tugas dimulai di `task_begin` atau implisit di tool pertama yang menyentuh
tab; berakhir di `task_end`. Saat berakhir, 🟢/badge "AI"/dot favicon dilepas
seketika dan hanya penanda hasil yang bertahan sebentar:

| Hasil | Pill | Judul / badge | Durasi |
|---|---|---|---|
| `done` | hijau "selesai ✓ · N langkah · durasi" | `✅` / "OK" | ±4 detik |
| `timeout` | amber "agent berhenti tanpa sinyal selesai" | `⚠️` / "!" | ±6 detik |
| `aborted` | amber "sesi agent ditutup" | `⚠️` / "!" | ±6 detik |

`timeout`: tidak ada tool selama 90 detik (`TASK_IDLE_TIMEOUT_MS`).
`aborted`: stdin MCP tertutup / server berhenti. Mockup: `design/Remora Task Indicator.html`.

| Hasil | Warna grup | Judul grup |
|---|---|---|
| berjalan | cyan | `🤖 Remora · <label> · langkah N` |
| `done` | green ±4 dtk → grey | `🤖 Remora · <label> · selesai ✓` → `🤖 Remora · siap` |
| `timeout` | orange ±6 dtk → grey | `🤖 Remora · berhenti tanpa sinyal` |
| `aborted` / sesi berakhir | orange ±6 dtk → ungroup | `🤖 Remora · sesi ditutup` (akses dicabut seketika) |

## 8. Upload File (final: injeksi bytes, tanpa dialog Explorer)

Agent TIDAK PERNAH klik `<input type=file>`. Alur:
MCP baca file → base64 via WS → content script buat `File` + `DataTransfer` →
set `input.files` → dispatch `change`/`input` (+ trik native setter React/Vue).
Drag-drop via event sintetis; file >50MB via chunking ±256KB + progress.

## 9. Aturan UI & Ikon (skill wajib)

- UI popup + pill: mockup dulu via skill **claude-design** menjadi
  `design/Remora Popup.html` (self-contained, archetype Operate), lengkap
  dengan Slop Diagnostic, BARU implementasikan ke extension.
- Ikon: via skill **create-icon** — 10 konsep di `assets/icons/concepts/`,
  pemenang di-refine, export `icon-{16,32,48,128}.png` + master SVG.
  Uji keterbacaan 16px adalah gate wajib.

## 10. Keamanan

- WS bind `127.0.0.1` saja. Extension diterima lewat header
  `Origin: chrome-extension://<id>` (halaman web ditolak 4403; opsional
  allowlist `extensionIds` di config) — user tidak pernah mengurus token.
  Proses MCP peer memakai token internal yang dibuat otomatis di config
  file (env `REMORA_TOKEN` diabaikan).
- Isolasi Tab Group: extension menolak request yang menyentuh tab di luar
  grup milik `agentId` peminta (`OUT_OF_GROUP`); user menyeret tab masuk =
  izin, keluar/tutup grup = cabut. Permission `tabGroups` + `tabs`.
  Edge case: `docs/SECURITY.md`.
- `evaluate_js` dan `net_capture_*` default OFF (toggle di popup).
- Kill-switch per-site di popup; audit log semua aksi agent di popup.
- `host_permissions: <all_urls>` — dokumentasikan risikonya di
  `docs/SECURITY.md`.

## 11. Definisi Done

- `npm run typecheck` dan `npm run test` bersih.
- Checklist E2E (docs/INSTALL.md) lolos: koneksi otomatis → snapshot → klik/ketik
  (pill+badge+title+highlight terlihat) → `task_end` (pill hijau ±4s, title pulih) →
  screenshot annotated → clipboard → upload 4 skenario → JS gated → network.
- Ikon tajam di toolbar 16px. Folder `dist/` siap rilis.
