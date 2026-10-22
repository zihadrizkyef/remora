#!/usr/bin/env python3
"""Generate 10 Remora icon concepts (SVG masters) + refine winner + export PNGs.

Palette (matches popup UI): teal #2DD4BF / #0D9488 on dark ink #0B1C1A.
Canvas 1024x1024, live area within ~128px safe padding, stroke ~64px.
"""
import os
from resvg_py import svg_to_bytes
from PIL import Image
import io

BASE = r"D:\Dev\Claude\Projects\Remora\assets\icons"
CONCEPTS = os.path.join(BASE, "concepts")
ICONS = r"D:\Dev\Claude\Projects\Remora\packages\extension\icons"
os.makedirs(CONCEPTS, exist_ok=True)
os.makedirs(ICONS, exist_ok=True)

BG = "#0B1C1A"
TEAL = "#2DD4BF"
TEAL_D = "#0D9488"
CREAM = "#EAFFFB"

BG_RECT = f'<rect x="0" y="0" width="1024" height="1024" rx="228" fill="{BG}"/>'

def svg(body: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f"{BG_RECT}{body}</svg>"
    )

FISH_SIDE = (
    # abstract remora side silhouette (body + tail + suction ridges on top)
    f'<path d="M220 560 C300 470 430 430 560 450 L760 470 L860 400 L830 520 L860 640 L760 570 L560 590 C430 610 300 620 220 560 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="56" stroke-linejoin="round"/>'
    f'<line x1="380" y1="452" x2="380" y2="500" stroke="{TEAL}" stroke-width="36" stroke-linecap="round"/>'
    f'<line x1="470" y1="448" x2="470" y2="496" stroke="{TEAL}" stroke-width="36" stroke-linecap="round"/>'
    f'<line x1="560" y1="448" x2="560" y2="496" stroke="{TEAL}" stroke-width="36" stroke-linecap="round"/>'
    f'<circle cx="290" cy="545" r="22" fill="{TEAL}"/>'
)

concepts: dict[str, str] = {}

# 1. remora side-view on a browser tab
concepts["01-side-remora-tab"] = svg(
    f'<rect x="180" y="620" width="664" height="200" rx="40" fill="none" stroke="{TEAL_D}" stroke-width="48"/>'
    f'<g transform="translate(0,-120) scale(0.92) translate(45,0)">{FISH_SIDE}</g>'
)

# 2. remora top-view + suction disc over a window
concepts["02-top-remora-window"] = svg(
    f'<rect x="200" y="600" width="624" height="220" rx="40" fill="none" stroke="{TEAL_D}" stroke-width="48"/>'
    f'<ellipse cx="512" cy="380" rx="150" ry="210" fill="none" stroke="{TEAL}" stroke-width="56"/>'
    f'<ellipse cx="512" cy="330" rx="80" ry="100" fill="none" stroke="{TEAL}" stroke-width="40"/>'
    f'<line x1="452" y1="300" x2="572" y2="300" stroke="{TEAL}" stroke-width="32" stroke-linecap="round"/>'
    f'<line x1="452" y1="340" x2="572" y2="340" stroke="{TEAL}" stroke-width="32" stroke-linecap="round"/>'
    f'<line x1="452" y1="380" x2="572" y2="380" stroke="{TEAL}" stroke-width="32" stroke-linecap="round"/>'
)

# 3. letter R + cursor arrow in counter
concepts["03-r-cursor"] = svg(
    f'<path d="M340 760 L340 280 L540 280 C660 280 720 340 720 430 C720 500 680 550 610 565 L730 760 L610 760 L505 580 L450 580 L450 760 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="60" stroke-linejoin="round"/>'
    f'<path d="M560 620 L560 800 L610 755 L645 820 L690 795 L655 730 L710 730 Z" fill="{TEAL}"/>'
)

# 4. magnifier whose lens is a tab
concepts["04-lens-tab"] = svg(
    f'<circle cx="440" cy="420" r="230" fill="none" stroke="{TEAL}" stroke-width="60"/>'
    f'<rect x="310" y="330" width="260" height="170" rx="28" fill="none" stroke="{TEAL}" stroke-width="40"/>'
    f'<line x1="610" y1="590" x2="790" y2="770" stroke="{TEAL}" stroke-width="80" stroke-linecap="round"/>'
)

# 5. U magnet attached to a tab
concepts["05-magnet-tab"] = svg(
    f'<path d="M330 300 L330 580 C330 700 410 780 512 780 C614 780 694 700 694 580 L694 300 L574 300 L574 560 C574 620 550 660 512 660 C474 660 450 620 450 560 L450 300 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="60" stroke-linejoin="round"/>'
    f'<rect x="180" y="800" width="664" height="90" rx="30" fill="{TEAL_D}"/>'
)

# 6. puzzle piece + remora fin
concepts["06-puzzle-fin"] = svg(
    f'<path d="M300 350 L480 350 L480 300 C480 260 540 260 540 310 C540 360 600 360 600 310 L600 300 L600 260 L700 260 L700 700 L400 700 L400 560 L350 560 C300 560 300 500 350 500 C400 500 400 440 350 440 L300 440 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="56" stroke-linejoin="round"/>'
    f'<path d="M640 700 L800 700 L720 800 Z" fill="{TEAL}"/>'
)

# 7. robot eye inside chrome circle
concepts["07-robot-eye"] = svg(
    f'<circle cx="512" cy="512" r="300" fill="none" stroke="{TEAL}" stroke-width="60"/>'
    f'<ellipse cx="512" cy="512" rx="150" ry="95" fill="none" stroke="{TEAL}" stroke-width="48"/>'
    f'<circle cx="512" cy="512" r="42" fill="{TEAL}"/>'
)

# 8. browser tab + suction disc dot (WINNER candidate: simplest)
concepts["08-tab-dot"] = svg(
    f'<path d="M200 340 L200 700 C200 730 220 750 250 750 L774 750 C804 750 824 730 824 700 L824 340 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="60" stroke-linejoin="round"/>'
    f'<line x1="200" y1="460" x2="824" y2="460" stroke="{TEAL}" stroke-width="44"/>'
    f'<circle cx="330" cy="400" r="26" fill="{TEAL}"/>'
    f'<circle cx="600" cy="610" r="70" fill="none" stroke="{TEAL}" stroke-width="48"/>'
    f'<circle cx="600" cy="610" r="20" fill="{TEAL}"/>'
)

# 9. wave + cursor
concepts["09-wave-cursor"] = svg(
    f'<path d="M180 620 C280 560 340 560 440 620 C540 680 600 680 700 620 C760 590 800 590 844 620" '
    f'fill="none" stroke="{TEAL}" stroke-width="56" stroke-linecap="round"/>'
    f'<path d="M430 280 L430 560 L490 505 L530 600 L590 572 L550 478 L630 478 Z" fill="{TEAL}"/>'
)

# 10. monogram R + tail fin minimal
concepts["10-r-fin-minimal"] = svg(
    f'<path d="M360 760 L360 280 L560 280 C680 280 740 350 740 440 C740 520 700 570 630 585 L760 760 L640 760 L530 595 L470 595 L470 760 Z" '
    f'fill="{TEAL}"/>'
    f'<path d="M470 595 L640 595 L560 680 Z" fill="{BG}"/>'
)

saved = []
for name, art in concepts.items():
    path = os.path.join(CONCEPTS, name + ".svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(art)
    saved.append(path)

# Refined winner: concept 08 with optical tweaks (thicker ring, centered disc)
master = svg(
    f'<path d="M212 330 L212 695 C212 730 235 752 270 752 L754 752 C789 752 812 730 812 695 L812 330 Z" '
    f'fill="none" stroke="{TEAL}" stroke-width="66" stroke-linejoin="round"/>'
    f'<line x1="212" y1="458" x2="812" y2="458" stroke="{TEAL}" stroke-width="46"/>'
    f'<circle cx="335" cy="394" r="27" fill="{TEAL}"/>'
    f'<circle cx="605" cy="612" r="76" fill="none" stroke="{TEAL}" stroke-width="52"/>'
    f'<circle cx="605" cy="612" r="22" fill="{TEAL}"/>'
)
master_path = os.path.join(BASE, "master.svg")
with open(master_path, "w", encoding="utf-8") as f:
    f.write(master)

# Export PNGs from master
for size in (16, 32, 48, 128):
    png = svg_to_bytes(svg_string=master, background=BG, width=size, height=size)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    out = os.path.join(ICONS, f"icon-{size}.png")
    img.save(out, "PNG")
    print("wrote", out, img.size)

print(f"concepts: {len(saved)}")
print("master:", master_path)
