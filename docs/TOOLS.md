# Katalog MCP Tools Remora

58 tools. Semua argumen `tabId` opsional (default: tab aktif). Semua target
elemen memakai `ref` (dari `snapshot`, disarankan) atau `selector` (CSS,
fallback). Setiap tool yang menyentuh tab memicu indikator agent aktif
(pill + badge + prefix judul).

## Klaim tab (multi-agent)

Setiap sesi agent punya identitas sendiri. Tab yang dibuat otomatis diklaim
pemiliknya; tool yang MENGUBAH tab milik sesi lain gagal cepat dengan error
`TAB_CLAIMED` yang menyebut pemiliknya. Tool baca (snapshot, screenshot,
page_text, …) selalu lolos.

| Tool | Argumen | Deskripsi |
|---|---|---|
| `tab_claim` | `tabId?`, `note?` | Klaim tab untuk sesi ini (eksklusif). |
| `tab_release` | `tabId?` | Lepas klaim tab. |

`tabs_list` menandai tab yang diklaim (`claimedBy`, `claimNote`,
`claimedByMe`); `remora_status` mengembalikan daftar `claims` aktif.
Klaim hilang saat tab ditutup atau sesi pemiliknya berhenti.

Konvensi respons: JSON. `screenshot`/`screenshot_annotated` mengembalikan
gambar + metadata ringkas.

## Koneksi

| Tool | Deskripsi |
|---|---|
| `remora_status` | Status bridge: extension terhubung?, versi, jumlah tab, tab aktif agent. |
| `task_begin` | Umumkan tugas mulai (`label?`, maks 60 karakter). Indikator menyala sampai `task_end`. |
| `task_end` | Umumkan tugas selesai. Panggil sebelum jawaban akhir; tanpa ini indikator baru padam setelah 90 detik dan tampil sebagai "berhenti tanpa sinyal selesai". |

## Tab & Window

| Tool | Argumen | Deskripsi |
|---|---|---|
| `tabs_list` | — | Semua tab (id, title, url, active, pinned). |
| `tab_activate` | `tabId` | Fokuskan tab. |
| `tab_create` | `url?`, `active?` | Tab baru, opsional langsung buka URL. |
| `tab_close` | `tabId?` | Tutup tab (default aktif). |
| `tab_duplicate` | `tabId?` | Duplikat tab. |
| `tab_pin` | `tabId?`, `pinned` | Pin/unpin. |
| `tab_mute` | `tabId?`, `muted` | Mute/unmute. |
| `tab_move` | `tabId?`, `index`, `windowId?` | Pindah posisi/window. |
| `windows_list` | — | Daftar window (id, focused, jumlah tab). |

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
| `clipboard_read` | — | Baca clipboard OS (butuh halaman fokus). |
| `clipboard_write` | `text` | Tulis clipboard OS. |
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
| `cookies_list` | `url?` | Daftar cookies. |
| `cookies_set` | `url`, `name`, `value`, `expirationDate?` | Set cookie. |
| `cookies_clear` | `url?` | Hapus cookies. |
| `storage_get` | `tabId?`, `area` (`local`/`session`), `keys?` | Baca storage (tanpa `keys` = semua). |
| `storage_set` | `tabId?`, `area`, `entries?`, `remove?` | Tulis/hapus storage. |

## Network (gated)

| Tool | Argumen | Deskripsi |
|---|---|---|
| `net_capture_start` | `tabId?`, `urlPattern?` | Mulai rekam request. **Default OFF** — aktifkan di popup. |
| `net_capture_stop` | `tabId?` | Berhenti merekam. |
| `net_capture_get` | `tabId?`, `clear?` | Ambil hasil (method, url, status, durasi). |
| `net_block` | `enabled`, `patterns[]?` | Blokir request via pola substring URL. `patterns` wajib saat `enabled: true`, boleh dikosongkan saat mematikan. Diterapkan lewat `declarativeNetRequest` (bukan blocking `webRequest`, yang dilarang MV3). |

## File & Upload (tanpa dialog Explorer)

Agent **tidak pernah klik** tombol file. File dibaca MCP dari disk lalu
di-inject langsung ke `<input type=file>` atau dropzone.

| Tool | Argumen | Deskripsi |
|---|---|---|
| `upload_file` | target + `filePath` (absolut) | Upload 1 file ke input file. |
| `upload_files` | target + `filePaths[]` (maks 10) | Upload banyak file ke 1 input. |
| `drag_drop_files` | target + `filePaths[]` (maks 10) | Drop file ke dropzone. |
| `downloads_list` | `limit?` | Unduhan terbaru. |

Batas: ±200MB per file; >50MB otomatis chunking dengan progress.
Contoh:

```
upload_file({ selector: "input[type=file]", filePath: "D:/docs/laporan.pdf" })
```

## Error Umum (pesan agent)

- `extension tidak terhubung` → buka Chrome + pairing ulang.
- `ref … stale` / `page navigated` → panggil `snapshot` lagi.
- `cannot be automated` → halaman browser-internal; navigasi ke web biasa.
- `NOT_ALLOWED` → cek toggle popup (JS eval / network capture).
- `SITE_BLOCKED` → user memblokir situs; berhenti dan beri tahu user.
