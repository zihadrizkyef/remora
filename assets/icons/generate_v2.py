#!/usr/bin/env python3
"""Remora icon concepts round 2: 10 SVG masters + contact sheet with 16/32/48px tests.

Palette follows the popup UI: teal #2DD4BF / #0D9488, cream #EAFFFB, ink #0B1C1A.
Canvas 1024, tile rx 228, live area ~128px safe padding.
"""
import io
import math
import os

from PIL import Image, ImageDraw, ImageFont
from resvg_py import svg_to_bytes

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "concepts-v2")
os.makedirs(OUT, exist_ok=True)

INK = "#0B1C1A"
TEAL = "#2DD4BF"
TEAL_D = "#0D9488"
CREAM = "#EAFFFB"


def svg(body, defs=""):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<defs><clipPath id="tile"><rect width="1024" height="1024" rx="228"/></clipPath>{defs}</defs>'
        f'<rect width="1024" height="1024" rx="228" fill="{INK}"/>'
        f'<g clip-path="url(#tile)">{body}</g></svg>'
    )


# Fish facing right, centered at origin, length 640; flat head carries the disc lamellae.
FISH_BODY = (
    "M320 0 C270 -80 120 -112 -60 -84 L-200 -52 L-310 -130 L-270 0 "
    "L-310 130 L-200 52 L-60 84 C120 112 270 80 320 0 Z"
)


def fish(transform, color=TEAL, detail=INK):
    lam = "".join(
        f'<line x1="{x}" y1="-60" x2="{x}" y2="-24" stroke="{detail}" stroke-width="24" stroke-linecap="round"/>'
        for x in (40, 100, 160)
    )
    eye = f'<circle cx="245" cy="6" r="22" fill="{detail}"/>'
    return f'<g transform="{transform}"><path d="{FISH_BODY}" fill="{color}"/>{lam}{eye}</g>'


def disc_bars(cx, cy, rx, ry, n, vertical_bars=False, w=34):
    """Chevron-free lamellae bars inside an ellipse, split by a centre seam."""
    out = []
    for i in range(n):
        if not vertical_bars:
            y = cy - ry + (i + 1) * (2 * ry) / (n + 1)
            hw = rx * math.sqrt(max(0.0, 1 - ((y - cy) / ry) ** 2))
            for a, b in ((cx - hw + 46, cx - 26), (cx + 26, cx + hw - 46)):
                if b > a:
                    out.append(f'<line x1="{a:.0f}" y1="{y:.0f}" x2="{b:.0f}" y2="{y:.0f}" stroke="{INK}" stroke-width="{w}" stroke-linecap="round"/>')
        else:
            x = cx - rx + (i + 1) * (2 * rx) / (n + 1)
            hh = ry * math.sqrt(max(0.0, 1 - ((x - cx) / rx) ** 2))
            for a, b in ((cy - hh + 30, cy - 18), (cy + 18, cy + hh - 30)):
                if b > a:
                    out.append(f'<line x1="{x:.0f}" y1="{a:.0f}" x2="{x:.0f}" y2="{b:.0f}" stroke="{INK}" stroke-width="{w}" stroke-linecap="round"/>')
    return "".join(out)


def c01():  # top view of the suction disc
    return (
        f'<ellipse cx="512" cy="512" rx="250" ry="340" fill="{TEAL}"/>'
        + disc_bars(512, 512, 250, 340, 6)
    )


def c02():  # fish as cursor, snout = pointer tip, click ticks
    tip = (304, 314)
    ticks = [((304, 240), (304, 170)), ((230, 314), (160, 314)), ((252, 262), (203, 213))]
    t = "".join(
        f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{CREAM}" stroke-width="40" stroke-linecap="round"/>'
        for a, b in ticks
    )
    return fish("translate(530 540) rotate(-135) scale(1 -1)") + t


def c03():  # host body + remora clinging underneath
    return (
        f'<circle cx="512" cy="110" r="450" fill="{TEAL_D}"/>'
        + fish("translate(512 668) scale(0.86)")
    )


def c04():  # browser window, disc clamped on the title bar
    return (
        f'<rect x="176" y="320" width="672" height="480" rx="72" fill="none" stroke="{CREAM}" stroke-width="56"/>'
        f'<line x1="176" y1="450" x2="848" y2="450" stroke="{CREAM}" stroke-width="44"/>'
        f'<ellipse cx="512" cy="320" rx="210" ry="116" fill="{TEAL}" stroke="{INK}" stroke-width="28"/>'
        + disc_bars(512, 320, 196, 102, 5, vertical_bars=True, w=28)
    )


def c05():  # browser tab whose body is the suction disc
    tab = (
        "M150 724 C220 724 244 704 254 640 L290 390 C298 336 330 300 386 300 "
        "L638 300 C694 300 726 336 734 390 L770 640 C780 704 804 724 874 724 Z"
    )
    bars = "".join(
        f'<line x1="{a}" y1="{y}" x2="{b}" y2="{y}" stroke="{INK}" stroke-width="36" stroke-linecap="round"/>'
        for y in (400, 480, 560, 640)
        for a, b in ((350, 486), (538, 674))
    )
    return (
        f'<line x1="120" y1="742" x2="904" y2="742" stroke="{CREAM}" stroke-width="44" stroke-linecap="round"/>'
        f'<path d="{tab}" fill="{TEAL}"/>' + bars
    )


def c06():  # R monogram, leg ends in a tail fork
    return (
        f'<path d="M340 800 V240 H560 C680 240 736 318 736 398 C736 480 680 556 560 556 H340" '
        f'fill="none" stroke="{TEAL}" stroke-width="104" stroke-linejoin="round" stroke-linecap="round"/>'
        f'<line x1="540" y1="556" x2="660" y2="740" stroke="{TEAL}" stroke-width="104" stroke-linecap="round"/>'
        f'<path d="M660 740 L800 690 L752 790 L800 880 Z" fill="{TEAL_D}" stroke="{TEAL_D}" stroke-width="40" stroke-linejoin="round"/>'
    )


def c07():  # suction cup pressed onto a screen surface
    return (
        f'<rect x="452" y="210" width="120" height="260" rx="60" fill="{TEAL_D}"/>'
        f'<path d="M244 742 C244 520 372 430 512 430 C652 430 780 520 780 742 Z" fill="{TEAL}"/>'
        f'<line x1="150" y1="770" x2="874" y2="770" stroke="{CREAM}" stroke-width="56" stroke-linecap="round"/>'
    )


def c08():  # mascot: bold remora silhouette
    return fish("translate(520 520) scale(1.18)")


def c09():  # pointer stuck with a disc at its tip
    cursor = "M372 268 L372 752 L480 650 L560 828 L640 794 L562 622 L712 622 Z"
    return (
        f'<circle cx="372" cy="268" r="140" fill="{TEAL}"/>'
        f'<circle cx="372" cy="268" r="82" fill="none" stroke="{INK}" stroke-width="26"/>'
        f'<path d="{cursor}" fill="{CREAM}" stroke="{INK}" stroke-width="34" stroke-linejoin="round"/>'
    )


def c10():  # fish curled into a ring around the target
    cx = cy = 512
    r = 250
    a0, a1 = math.radians(-50), math.radians(220)
    p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
    p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
    body = (
        f'<path d="M{p0[0]:.1f} {p0[1]:.1f} A{r} {r} 0 1 1 {p1[0]:.1f} {p1[1]:.1f}" '
        f'fill="none" stroke="{TEAL}" stroke-width="120" stroke-linecap="round"/>'
    )
    # tail fork continues along the tangent at the arc end
    tx, ty = math.sin(a1), -math.cos(a1)
    fork = []
    for s in (1, -1):
        ang = math.atan2(ty, tx) + s * math.radians(40)
        fork.append((p1[0] + 150 * math.cos(ang), p1[1] + 150 * math.sin(ang)))
    tail = (
        f'<path d="M{p1[0]:.1f} {p1[1]:.1f} L{fork[0][0]:.1f} {fork[0][1]:.1f} '
        f'L{fork[1][0]:.1f} {fork[1][1]:.1f} Z" fill="{TEAL}" stroke="{TEAL}" stroke-width="40" stroke-linejoin="round"/>'
    )
    lam = ""
    for deg in (-25, -5, 15):
        a = math.radians(deg)
        lam += (
            f'<line x1="{cx + 270 * math.cos(a):.0f}" y1="{cy + 270 * math.sin(a):.0f}" '
            f'x2="{cx + 296 * math.cos(a):.0f}" y2="{cy + 296 * math.sin(a):.0f}" '
            f'stroke="{INK}" stroke-width="22" stroke-linecap="round"/>'
        )
    ea = math.radians(-58)
    eye = f'<circle cx="{cx + 236 * math.cos(ea):.0f}" cy="{cy + 236 * math.sin(ea):.0f}" r="20" fill="{INK}"/>'
    return body + tail + lam + eye + f'<circle cx="512" cy="512" r="78" fill="{TEAL_D}"/>'


CONCEPTS = [
    ("01-cakram", "Cakram penghisap", c01),
    ("02-kursor-ikan", "Ikan = kursor", c02),
    ("03-inang", "Inang + remora", c03),
    ("04-jendela-cakram", "Cakram di jendela", c04),
    ("05-tab-cakram", "Tab = cakram", c05),
    ("06-monogram-r", "Monogram R-ekor", c06),
    ("07-suction-cup", "Mangkuk hisap", c07),
    ("08-maskot-ikan", "Maskot remora", c08),
    ("09-kursor-tempel", "Kursor menempel", c09),
    ("10-ikan-melingkar", "Ikan melingkar", c10),
]


def render(art, size):
    return Image.open(io.BytesIO(bytes(svg_to_bytes(svg_string=art, width=size, height=size)))).convert("RGBA")


def main():
    cell_w, cell_h = 420, 360
    sheet = Image.new("RGB", (cell_w * 5, cell_h * 2), "#F4F5F7")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("segoeui.ttf", 18)
        small = ImageFont.truetype("segoeui.ttf", 13)
    except OSError:
        font = small = ImageFont.load_default()
    for i, (slug, label, fn) in enumerate(CONCEPTS):
        art = svg(fn())
        with open(os.path.join(OUT, f"{slug}.svg"), "w", encoding="utf-8") as fh:
            fh.write(art)
        ox, oy = (i % 5) * cell_w, (i // 5) * cell_h
        big = render(art, 220)
        sheet.paste(big, (ox + 20, oy + 20), big)
        # real-size tests on light and dark strips
        for k, size in enumerate((48, 32, 16)):
            x = ox + 256 + k * 52
            for j, bg in enumerate(("#FFFFFF", "#202124")):
                draw.rectangle([x - 4, oy + 20 + j * 70, x + 52, oy + 76 + j * 70], fill=bg)
                im = render(art, size)
                sheet.paste(im, (x + (48 - size) // 2, oy + 24 + j * 70 + (48 - size) // 2), im)
        # 16px zoomed x4 to judge pixel legibility
        z = render(art, 16).resize((64, 64), Image.NEAREST)
        sheet.paste(z, (ox + 256, oy + 170), z)
        draw.text((ox + 330, oy + 190), "16px x4", fill="#8B919E", font=small)
        draw.text((ox + 20, oy + 260), f"{slug[:2]} · {label}", fill="#14161C", font=font)
    sheet.save(os.path.join(BASE, "contact-sheet-v2.png"))
    print("ok", OUT)


if __name__ == "__main__":
    main()
