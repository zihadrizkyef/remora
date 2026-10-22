# Rekomendasi Ikon Remora

Master: `assets/icons/master.svg` (1024 viewBox, teal `#2DD4BF` di atas ink `#0B1C1A`).
Export: `packages/extension/icons/icon-{16,32,48,128}.png` via `generate.py` (resvg-py, background opaque).

## Top 3

1. **08-tab-dot (PEMENANG)** — jendela tab + cincin cakram penghisap remora.
   Alasan: satu ide ("agent menempel pada browser"), bentuk paling sederhana,
   terbaca di 16px (siluet tab + 1 titik fokus). Refine: stroke 66px,
   divider 46px, cincin r=76/w=52, dot r=22 — lolos uji 16px (tab + dot masih terbaca).
2. **07-robot-eye** — mata robot dalam lingkaran.
   Alasan: menyampaikan "agent melihat". Cadangan bila 08 dirasa terlalu generik.
   Kelemahan: lingkaran-dalam-lingkaran sedikit ramai di 16px.
3. **03-r-cursor** — huruf R + kursor di counter.
   Alasan: paling tegas sebagai merek huruf. Kelemahan: melanggar "no text"
   (pengecualian untuk monogram), kursor kecil hilang di 16px.

## Skalabilitas (semua konsep)

- 128px: semua 10 terbaca.
- 32/48px: 01, 02, 04, 06 mulai ramai (detail ikan/jendela ganda).
- 16px: hanya 08, 07, 10 yang bertahan; 08 paling bersih.

## Checklist principles

- Satu ide utama, tanpa teks (kecuali konsep R yang memang dievaluasi),
  tanpa foto/shadow-baked, background solid opaque, keyline persegi
  1024 + safe padding ±128px, stroke konsisten per ikon.

## Putaran 2 (`concepts-v2/`, sheet: `contact-sheet-v2.png`)

Dibuat ulang via `generate_v2.py` — tile ink + teal/cream, uji 48/32/16px di latar terang & gelap.

| # | Konsep | 16px |
|---|---|---|
| 01 | Cakram penghisap (tampak atas) | ✅ oval tegas |
| 02 | Ikan = kursor | ⚠️ jadi garis miring |
| 03 | Inang + remora | ⚠️ ikan hilang |
| 04 | Cakram di jendela | ✅ |
| 05 | Tab = cakram | ✅ siluet tab kuat |
| 06 | Monogram R-ekor | ✅ (pakai huruf) |
| 07 | Mangkuk hisap | ✅ tapi mirip "lonceng" |
| 08 | Maskot remora | ⚠️ jadi garis datar |
| 09 | Kursor menempel | ✅ |
| 10 | Ikan melingkar | ✅ cincin + titik |

Kandidat kuat: **05**, **01**, **10**.
