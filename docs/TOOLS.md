# Katalog MCP Tools Remora

56 tools. Semua argumen `tabId` opsional (default: **working tab di grup
sesi ini**, bukan tab aktif window). Semua target elemen memakai `ref` (dari
`snapshot`, disarankan) atau `selector` (CSS, fallback). Setiap tool yang
menyentuh tab memicu indikator agent aktif (judul grup + pill + badge +
prefix judul).

## Isolasi tab: grup per sesi

Setiap sesi agent (satu proses MCP = satu `agentId`) punya **satu Chrome Tab
Group** sendiri, judul `🤖 Remora · <label> · langkah N`. Aturan keras,
ditegakkan di extension dan divalidasi ulang di MCP server:

- Agent hanya bisa menyentuh tab di dalam grupnya. Tab lain — milik user,
  di grup user, atau di grup sesi lain — ditolak dengan `OUT_OF_GROUP`,
  termasuk untuk tool baca (`snapshot`, `screenshot`, `page_text`, …).
- Grup dibuat otomatis oleh `tab_create` pertama. Tanpa tab di grup, tool
  tanpa `tabId` gagal dan menyuruh memanggil `tab_create`.
- Tab yang dibuka dari tab grup (`target=_blank`, `window.open`) ikut masuk
  grup. User yang menyeret tab **masuk** grup memberi izin; menyeret
  **keluar**, ungroup, atau menutup grup mencabut akses seketika.
- `tabs_list` hanya berisi tab grup ini; `remora_status` hanya menyebut
  jumlah tab lain ("N tab lain disembunyikan").
- Grup bertahan selama sesi hidup (tidak dilepas saat `task_end`), dan
  dilepas saat proses MCP berhenti atau semua tabnya ditutup.

Warna grup: cyan = berjalan, green = selesai (±4 dtk), orange = timeout /
sesi ditutup (±6 dtk), grey = siap.

Konvensi respons: JSON. `screenshot`/`screenshot_annotated` mengembalikan
gambar + metadata ringkas.

## Koneksi

| Tool | Deskripsi |
|---|---|
| `remora_status` | Status bridge: extension terhubung?, versi, `agentId`, grup sesi ini (`group`), jumlah tab lain yang disembunyikan (`hiddenTabs`), aksi terakhir di tab grup. |
| `task_begin` | Umumkan tugas mulai (`label?`, maks 60 karakter). Indikator menyala sampai `task_end`. |
| `task_end` | Umumkan tugas selesai. Panggil sebelum jawaban akhir; tanpa ini indikator baru padam setelah 90 detik dan tampil sebagai "berhenti tanpa sinyal selesai". |

## Tab & Window

| Tool | Argumen | Deskripsi |
|---|---|---|
| `tabs_list` | — | Tab di grup sesi ini saja (id, title, url, active, pinned, groupId). |
| `tab_activate` | `tabId` | Fokuskan tab grup. |
| `tab_create` | `url?`, `active?` | Tab baru **di dalam grup sesi** (grup dibuat saat pertama). Satu-satunya cara mendapat tab kerja. |
| `tab_close` | `tabId?` | Tutup tab grup (default working tab). |
| `tab_duplicate` | `tabId?` | Duplikat tab grup; salinannya ikut grup. |
| `tab_pin` | `tabId?`, `pinned` | Unpin saja. `pinned: true` ditolak: Chrome mengeluarkan tab yang di-pin dari grupnya. |
| `tab_mute` | `tabId?`, `muted` | Mute/unmute. |
| `tab_move` | `tabId?`, `index`, `windowId?` | Urutkan ulang di dalam grup (index dijepit ke rentang grup). Pindah ke window lain ditolak. |
| `windows_list` | — | Hanya window yang memuat grup sesi (tabCount = jumlah tab grup). |

## Navigasi

| Tool | Argumen | Deskripsi |
|---|---|---|
| `navigate` | `tabId?`, `url` | Buka URL penuh (http/https). |
| `go_back` | `tabId?` | Kembali. |
| `go_forward` | `tabId?` | Maju. |
| `reload` | `tabId?`, `hard?` | Muat ulang; `hard` lewati cache. |

## Persepsi

| Tool | Argumen | Deskripsi |
|---|---|---|
| `snapshot` | `tabId?`, `compact?` | **Tool inti.** Pohon aksesibilitas + refs `[ref=e12]`. Panggil ulang setelah navigasi. |
| `page_text` | `tabId?`, `maxChars?` | Teks visible (truncate). |
| `page_html` | `tabId?`, `ref?`, `selector?`, `maxChars?` | HTML halaman/elemen (truncate). |
| `query` | `tabId?`, `selector`, `limit?` | Cari elemen via CSS; kembalikan count + cuplikan. |
| `page_info` | `tabId?` | URL, title, readyState. |
| `console_logs` | `tabId?`, `level?`, `limit?` | Pesan console yang ditangkap. |
| `page_errors` | `tabId?`, `limit?` | Uncaught errors + unhandled rejections. |

Contoh alur baca:

```
snapshot({}) → temukan tombol [ref=e7]
click({ ref: "e7" })
snapshot({}) → baca hasil
```

## Visual

| Tool | Argumen | Deskripsi |
|---|---|---|
| `screenshot` | `tabId?`, `mode?` (`viewport`/`fullPage`/`selector`/`ref`), `ref?`, `selector?`, `format?`, `quality?` | Screenshot base64 PNG/JPEG. |
| `screenshot_annotated` | `tabId?` | Screenshot + badge bernomor di elemen interaktif; nomor = refs snapshot. |
| `export_pdf` | `tabId?`, `landscape?` | (Terbatas di build ini — butuh debugger; mengembalikan NOT_ALLOWED.) |

## Interaksi

| Tool | Argumen | Deskripsi |
|---|---|---|
| `click` | target + `button?`, `clickCount?` (1–3) | Klik/double/triple, kiri/tengah/kanan. |
| `hover` | target | Hover (buka menu/tooltip). |
| `type` | target + `text`, `submit?`, `clearFirst?` (default true) | Ketik ke input/textarea/contenteditable. |
| `fill_form` | `tabId?`, `fields[]` (`ref`/`selector`/`name` + `value`), `submit?` | Isi banyak field sekaligus. |
| `select_option` | target + `values[]` | Pilih opsi `<select>` via value/teks. |
| `set_checked` | target + `checked` | Checkbox/radio. |
| `scroll` | target? + `direction?`, `pixels?`, `intoView?` | Scroll halaman/elemen/ke view. |
| `drag` | `fromRef?`/`fromSelector?` + `toRef?`/`toSelector?`/`toX`/`toY` | Drag antar elemen/koordinat. |
| `press_key` | target? + `key` (`Enter`, `Tab`, `Escape`, `a`, `Control+c`, …) | Keyboard/shortcut. |
| `focus` | target | Fokus tanpa klik. |

`target` = `tabId?` + `ref?`/`selector?`.

## Clipboard

| Tool | Argumen | Deskripsi |
|---|---|---|
| `clipboard_read` | — | Baca clipboard OS. Hanya saat tab aktif = tab grup sesi ini. |
| `clipboard_write` | `text` | Tulis clipboard OS. Syarat sama. |
| `clipboard_copy_from` | target | Salin teks elemen ke clipboard. |
| `clipboard_paste_to` | target + `filePath?` | Paste: teks clipboard, atau **file lokal sebagai paste** (tanpa dialog). |

## Tunggu

| Tool | Argumen | Deskripsi |
|---|---|---|
| `wait_for` | `tabId?`, `selector?`, `text?`, `navigation?`, `timeoutMs?` (maks 120s) | Tunggu kondisi (disarankan). |
| `sleep` | `ms` (maks 60s) | Tunggu tetap (hindari bila bisa `wait_for`). |

## JS & Storage (JS gated)

| Tool | Argumen | Deskripsi |
|---|---|---|
| `evaluate_js` | `tabId?`, `expression`, `timeoutMs?` | Eval JS di ISOLATED world (akses DOM, bukan variabel page). **Default OFF** — aktifkan di popup. |
| `cookies_list` | `url?` | Cookies untuk situs yang terbuka di grup (tanpa `url` = semua tab grup; `url` lain ditolak `OUT_OF_GROUP`). |
| `cookies_set` | `url`, `name`, `value`, `expirationDate?` | Set cookie, hanya untuk situs yang terbuka di grup. |
| `cookies_clear` | `url?` | Hapus cookies situs di grup. |
| `storage_get` | `tabId?`, `area` (`local`/`session`), `keys?` | Baca storage (tanpa `keys` = semua). |
| `storage_set` | `tabId?`, `area`, `entries?`, `remove?` | Tulis/hapus storage. |

## Network (gated)

| Tool | Argumen | Deskripsi |
|---|---|---|
| `net_capture_start` | `tabId?`, `urlPattern?` | Mulai rekam request. **Default OFF** — aktifkan di popup. |
| `net_capture_stop` | `tabId?` | Berhenti merekam. |
| `net_capture_get` | `tabId?`, `clear?` | Ambil hasil (method, url, status, durasi). |
| `net_block` | `enabled`, `patterns[]?` | Blokir request via pola substring URL **hanya di tab grup sesi**. `patterns` wajib saat `enabled: true`. Diterapkan lewat session rule `declarativeNetRequest` ber-`tabIds`; hilang bersama grup. |

## File & Upload (tanpa dialog Explorer)

Agent **tidak pernah klik** tombol file. File dibaca MCP dari disk lalu
di-inject langsung ke `<input type=file>` atau dropzone.

| Tool | Argumen | Deskripsi |
|---|---|---|
| `upload_file` | target + `filePath` (absolut) | Upload 1 file ke input file. |
| `upload_files` | target + `filePaths[]` (maks 10) | Upload banyak file ke 1 input. |
| `drag_drop_files` | target + `filePaths[]` (maks 10) | Drop file ke dropzone. |
| `downloads_list` | `limit?` | Unduhan yang dimulai situs di grup selama sesi ini. |

Batas: ±200MB per file; >50MB otomatis chunking dengan progress.
Contoh:

```
upload_file({ selector: "input[type=file]", filePath: "D:/docs/laporan.pdf" })
```

## Error Umum (pesan agent)

- `extension tidak terhubung` → buka Chrome dan lihat alasan di popup Remora.
- `ref … stale` / `page navigated` → panggil `snapshot` lagi.
- `cannot be automated` → halaman browser-internal; navigasi ke web biasa.
- `NOT_ALLOWED` → cek toggle popup (JS eval / network capture).
- `SITE_BLOCKED` → user memblokir situs; berhenti dan beri tahu user.
- `OUT_OF_GROUP` → "tab di luar grup Remora milik sesi ini; buat tab dengan
  tab_create". Pakai `tabs_list` untuk tab grup, atau `tab_create`.
