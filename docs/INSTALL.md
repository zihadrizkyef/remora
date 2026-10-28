# Instalasi Remora

Panduan instalasi Chrome extension + MCP server di mesin lokal (Windows,
macOS, Linux). Estimasi waktu: ±10 menit.

## 1. Prasyarat

- Google Chrome 116+ (atau Chromium/Edge setara).
- Node.js 20+ (`node --version`).
- MCP client: Claude Desktop, ZCode, atau client MCP lain yang mendukung
  server stdio.

## 2. Build

```bash
cd D:/Dev/Claude/Projects/Remora
npm install
npm run build
```

Verifikasi:

```bash
npm run typecheck   # harus bersih
npm run test        # semua test lolos
```

Hasil build:

- Extension (siap load unpacked): `packages/extension/dist/`
- MCP server: `packages/mcp-server/dist/index.js`

## 3. Load Extension ke Chrome

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode** (kanan atas).
3. Klik **Load unpacked** → pilih folder `packages/extension/dist/`.
4. Pin ikon Remora ke toolbar agar mudah diakses.

> Catatan: halaman browser-internal (`chrome://`, Chrome Web Store,
> viewer PDF bawaan) tidak bisa diotomatisasi — itu batasan Chrome,
> bukan bug Remora. Navigasikan ke halaman web biasa untuk testing.

## 4. Hubungkan ke MCP Client (tanpa token)

Tidak ada token yang perlu disalin. Extension otomatis tersambung ke
MCP server mana pun yang berjalan di `127.0.0.1:47291`.

1. Klik ikon Remora → **Copy MCP config JSON**. Hasilnya:
   ```json
   {
     "mcpServers": {
       "remora": {
         "command": "node",
         "args": ["D:/Dev/Claude/Projects/Remora/packages/mcp-server/dist/index.js"]
       }
     }
   }
   ```
2. Tempel ke config tiap MCP client yang mau memakai Remora:
   - Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
   - ZCode: pengaturan MCP workspace.
3. Restart MCP client. Popup berubah hijau "Terhubung" dalam beberapa
   detik.

Banyak client (Claude + ZCode) boleh jalan bersamaan: proses pertama
memegang port, yang lain menumpang otomatis. Token internal antar-proses
ada di `%APPDATA%\remora\config.json` (`~/.remora/config.json` di
macOS/Linux) dan dibuat sendiri — tidak perlu disentuh. `REMORA_TOKEN`
di env sudah tidak dipakai dan boleh dihapus.

### Kalau tidak tersambung

Banner merah di popup menyebut penyebabnya:

| Pesan | Artinya | Solusi |
|---|---|---|
| Server MCP tidak berjalan | Tidak ada proses Remora di port | Buka Claude / ZCode yang memuat Remora |
| MCP server masih versi lama | Proses lama dari sebelum update | Tutup lalu buka lagi Claude / ZCode |
| Diambil alih koneksi lain | Remora aktif di profil Chrome lain | Matikan salah satunya |
| Tidak ada di daftar extensionIds | `extensionIds` di config membatasi extension | Tambahkan id extension ini, atau hapus daftarnya |
| Versi tidak cocok | Server/extension beda build | `npm run build`, reload extension, restart MCP client |

## 5. Uji Cepat (Smoke Test)

Di MCP client, jalankan tool berurutan:

1. `remora_status` → `connected: true`.
2. `tab_create` dengan `url: "https://example.com"` → tab baru muncul di
   grup `🤖 Remora · …`.
3. `snapshot` → harus ada tree dengan `[ref=eN]`.
4. `screenshot` → gambar tampil di respons.
5. `click` sebuah ref → pill "Remora · agent aktif" muncul di halaman,
   badge di ikon extension, dan `● ` di judul tab.

Jika `remora_status` bilang tidak terhubung: pastikan Chrome terbuka,
extension aktif (bukan abu-abu), dan tidak ada
aplikasi lain memakai port 47291.

### Beberapa sesi agent sekaligus

Setiap sesi MCP men-spawn proses server sendiri, dan semuanya memakai port
yang sama. Hanya satu proses yang bisa memegang port; proses lain otomatis
**attach** ke hub itu lewat channel kontrol localhost, lalu meneruskan
request lewat hub tersebut. Semua sesi mendapat 56 tool, tetapi tiap sesi
hanya melihat dan menyentuh tab di grup Remora miliknya sendiri.

`remora_status` melaporkan peran proses lewat `hubRole`:

- `primary` — proses ini memegang port dan bicara langsung ke extension.
- `attached` — proses ini menumpang ke hub milik sesi lain.

Kalau proses `primary` berhenti, salah satu proses `attached` mengambil alih
port dalam ~1 detik dan extension reconnect otomatis. Tidak perlu restart
ZCode.

Kalau startup gagal dengan pesan `does not speak the Remora control
protocol`, berarti port 47291 dipegang program lain (bukan Remora). Bebaskan
port itu, atau ganti `REMORA_PORT` di config MCP **dan** di popup extension.

## 6. Toggle Pengaman

Default aman:

- **JS eval: OFF** — `evaluate_js` ditolak sampai user mengaktifkan.
- **Network capture: OFF** — `net_capture_*` ditolak sampai diaktifkan.
- **Kill-switch situs** — situs yang diblokir menolak semua aksi agent.

Detail model ancaman: `docs/SECURITY.md`.

## 7. Update / Rebuild

Setelah `git pull` atau edit kode:

```bash
npm run build
```

Lalu di `chrome://extensions` tekan **Reload** pada Remora, dan restart
MCP server di client.

## 8. Checklist E2E (Definisi Done)

Jalankan berurutan, semua harus lolos:

- [ ] Koneksi otomatis: dot hijau tanpa token, `remora_status.connected == true`.
- [ ] `tabs_list` / `tab_create` / `navigate` / `go_back` / `reload`.
- [ ] `tab_create` pertama membuat grup `🤖 Remora · …` (cyan saat berjalan);
      `tabs_list` hanya berisi tab grup; `remora_status.hiddenTabs`
      menyebut jumlah tab lain tanpa url/title.
- [ ] Tab di luar grup ditolak: `snapshot`/`click`/`screenshot` dengan
      `tabId` tab user → `OUT_OF_GROUP`; tanpa tab grup, `click` tanpa
      `tabId` → error yang menyuruh `tab_create`.
- [ ] Grup bertahan saat `navigate`/`reload` dan saat `task_end` (hanya
      warna/judul berubah: green "selesai ✓" ±4 dtk lalu grey "siap").
- [ ] Drag-in: seret tab user ke grup → muncul di `tabs_list`, bisa
      di-`snapshot`. Drag-out: seret keluar → `OUT_OF_GROUP` seketika,
      pill/badge/prefix judul di tab itu hilang.
- [ ] Link `target=_blank` dari tab grup → tab baru otomatis masuk grup.
- [ ] `tab_move` dengan `windowId` lain → ditolak; `tab_pin pinned:true` → ditolak.
- [ ] Dua klien MCP sekaligus → dua grup terpisah; sesi A dapat
      `OUT_OF_GROUP` untuk tab sesi B.
- [ ] Tutup klien MCP → grup orange "sesi ditutup" ±6 dtk lalu di-ungroup,
      tab tetap terbuka.
- [ ] `snapshot` → klik/ketik via ref → **pill muncul** + badge + `● ` di
      title + highlight pulse 600ms di target.
- [ ] Pill tetap menyala selama tugas (tanpa fade) → `task_end` → pill hijau
      "selesai ✓" ±4 detik, title kembali normal. Tanpa `task_end`: 90 detik
      → pill amber "agent berhenti tanpa sinyal selesai".
- [ ] `screenshot_annotated` → badge bernomor cocok dengan refs snapshot.
- [ ] `clipboard_write` → `clipboard_paste_to` ke kolom teks.
- [ ] Upload: `upload_file` ke input file (tanpa dialog Explorer!),
      `upload_files` multiple, `drag_drop_files` ke dropzone,
      `clipboard_paste_to` dengan `filePath` (paste file).
- [ ] `upload_file` dengan file >50MB (chunking + progress, ±200MB aman).
- [ ] `evaluate_js` saat toggle OFF → ditolak NOT_ALLOWED; ON → jalan.
- [ ] `net_capture_start` → navigasi → `net_capture_get` ada entries.
- [ ] `cookies_set` → `cookies_list` → `cookies_clear`.
- [ ] `storage_set`/`storage_get` (local + session).
- [ ] Popup → tab Log menampilkan semua aksi di atas.
- [ ] Ikon tajam di toolbar (16px) dan halaman extensions.
