#!/usr/bin/env python3
"""Render 10 Remora icon concepts (existing SVGs) to a contact sheet + PNG previews.

SVGs already follow create-icon rules: 1024 grid, one idea, ~64px stroke,
keyline shapes, teal on ink, no baked shadows/text (except letter concepts).
"""
import os, io
from resvg_py import svg_to_bytes
from PIL import Image, ImageDraw

BASE = r"D:\Dev\Claude\Projects\Remora\assets\icons"
CONCEPTS = os.path.join(BASE, "concepts")
os.makedirs(os.path.join(BASE, "previews"), exist_ok=True)

names = []
for f in sorted(os.listdir(CONCEPTS)):
    if not f.endswith(".svg"):
        continue
    with open(os.path.join(CONCEPTS, f), encoding="utf-8") as fh:
        art = fh.read()
    png = svg_to_bytes(svg_string=art, background="#0B1C1A", width=256, height=256)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    # per-concept preview
    img.save(os.path.join(BASE, "previews", f.replace(".svg", ".png")), "PNG")
    names.append((f.replace(".svg", ""), img))

cols, rows, cell, label_h = 5, 2, 256, 40
sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), "#eceef1")
d = ImageDraw.Draw(sheet)
for i, (name, img) in enumerate(names):
    r, c = divmod(i, cols)
    x, y = c * cell, r * (cell + label_h)
    sheet.paste(img, (x, y))
    d.text((x + 10, y + cell + 10), name, fill="#23262d")
sheet.save(os.path.join(BASE, "contact-sheet.png"), "PNG")
print(f"rendered {len(names)} concepts -> {os.path.join(BASE, 'contact-sheet.png')}")
