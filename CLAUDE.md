# CLAUDE.md — Remora

Instruksi kerja lengkap ada di [AGENTS.md](AGENTS.md) — baca itu dulu.

## Aturan Git (WAJIB, jangan dilanggar)

- **Selalu ngoding langsung di `main`.** JANGAN pernah membuat branch baru
  (feature/…, fix/…, apa pun namanya) dan jangan membuat PR.
- Setelah selesai: `git add` → `git commit` → `git push origin main`.
- Jangan meninggalkan branch tersisa; kalau ada, hapus lokal dan remote
  (`git branch -d <nama>`, `git push origin --delete <nama>`).
- Format commit: `tipe: ringkasan` (mis. `fix: portable MCP config`), satu
  commit untuk satu perubahan logis.
