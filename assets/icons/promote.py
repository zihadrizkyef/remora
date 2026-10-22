#!/usr/bin/env python3
"""Promote concept 01-cakram-violet to master and export Chrome extension sizes."""
import os, io
from resvg_py import svg_to_bytes
from PIL import Image

BASE = r"D:\Dev\Claude\Projects\Remora\assets\icons"
ICONS = r"D:\Dev\Claude\Projects\Remora\packages\extension\icons"
SRC = os.path.join(BASE, "concepts-v3", "01-cakram-violet.svg")
MASTER = os.path.join(BASE, "master.svg")

with open(SRC, encoding="utf-8") as f:
    art = f.read()

# master keeps the violet gradient tile (opaque background)
with open(MASTER, "w", encoding="utf-8") as f:
    f.write(art)

# Opaque violet background matches the tile's base stop.
BG = "#4C1D95"
for size in (16, 32, 48, 128):
    png = svg_to_bytes(svg_string=art, background=BG, width=size, height=size)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    out = os.path.join(ICONS, f"icon-{size}.png")
    img.save(out, "PNG")
    print("wrote", out, img.size)

# 128px preview for visual check
png = svg_to_bytes(svg_string=art, background=BG, width=128, height=128)
Image.open(io.BytesIO(png)).convert("RGB").save(os.path.join(BASE, "preview-master-128.png"), "PNG")
print("master:", MASTER)
