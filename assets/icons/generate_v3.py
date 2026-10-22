#!/usr/bin/env python3
"""Remora icon concepts round 3: 10 concepts, each with its own palette and style.

Canvas 1024, tile rx 228, live area ~128px safe padding. Contact sheet tests 48/32/16px.
"""
import io
import math
import os

from PIL import Image, ImageDraw, ImageFont
from resvg_py import svg_to_bytes

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "concepts-v3")
os.makedirs(OUT, exist_ok=True)


def svg(bg, body, defs=""):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<defs><clipPath id="tile"><rect width="1024" height="1024" rx="228"/></clipPath>{defs}</defs>'
        f'<rect width="1024" height="1024" rx="228" fill="{bg}"/>'
        f'<g clip-path="url(#tile)">{body}</g></svg>'
    )


def lin(id_, a, b, x1=0, y1=0, x2=0, y2=1):
    return (
        f'<linearGradient id="{id_}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
        f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
    )


# Remora profile facing right, length ~700: protruding lower jaw, flat disc head,
# long dorsal/anal fins at the rear, forked tail.
REMORA = (
    "M362 22 C352 -34 300 -84 226 -96 L40 -100 C-40 -98 -110 -88 -162 -74 "
    "C-196 -118 -246 -116 -262 -84 L-286 -54 L-336 -124 C-350 -140 -372 -130 -366 -110 "
    "L-334 0 L-366 110 C-372 130 -350 140 -336 124 L-286 54 L-262 84 "
    "C-246 116 -196 118 -162 76 C-80 96 60 102 204 80 C292 66 342 52 362 22 Z"
)


def remora(transform, body, disc, eye, lam=None):
    lam = lam or eye
    lines = "".join(
        f'<line x1="{x}" y1="-100" x2="{x}" y2="-70" stroke="{lam}" stroke-width="18" stroke-linecap="round"/>'
        for x in (78, 124, 170, 216)
    )
    return (
        f'<g transform="{transform}">'
        f'<path d="{REMORA}" fill="{body}"/>'
        f'<rect x="44" y="-114" width="206" height="58" rx="29" fill="{disc}"/>{lines}'
        f'<circle cx="286" cy="-18" r="24" fill="{eye}"/></g>'
    )


def c01():  # disc top view, chevron lamellae — violet / cyan
    defs = lin("g1", "#8B5CF6", "#4C1D95") + lin("d1", "#67E8F9", "#06B6D4")
    bars = ""
    for i in range(6):
        y = 280 + i * 100
        hw = 236 * math.sqrt(max(0.0, 1 - ((y - 530) / 350) ** 2)) - 52
        bars += (
            f'<path d="M{512 - hw:.0f} {y} L490 {y} M534 {y} L{512 + hw:.0f} {y}" '
            f'stroke="#4C1D95" stroke-width="40" stroke-linecap="round" fill="none"/>'
        )
    return svg(
        "url(#g1)",
        f'<ellipse cx="512" cy="530" rx="236" ry="350" fill="url(#d1)"/>{bars}'
        f'<line x1="512" y1="210" x2="512" y2="850" stroke="#4C1D95" stroke-width="22" stroke-linecap="round"/>',
        defs,
    )


def c02():  # remora riding under a shark belly — ocean / yellow
    defs = lin("g2", "#38BDF8", "#1E3A8A")
    shark = (
        '<path d="M-40 360 C200 300 520 300 760 360 C860 386 960 430 1060 470 '
        'L1060 -40 L-40 -40 Z" fill="#0F172A"/>'
        '<path d="M300 330 L380 440 L440 316 Z" fill="#0F172A"/>'
    )
    return svg(
        "url(#g2)",
        shark + remora("translate(520 520) scale(0.92) rotate(4)", "#FDE047", "#CA8A04", "#0F172A"),
        defs,
    )


def c03():  # remora diving onto a click target — blue / white / navy
    return svg(
        "#2563EB",
        '<ellipse cx="512" cy="790" rx="270" ry="70" fill="none" stroke="#93C5FD" stroke-width="30"/>'
        '<ellipse cx="512" cy="790" rx="150" ry="38" fill="none" stroke="#FFFFFF" stroke-width="30"/>'
        + remora("translate(470 450) rotate(50) scale(0.78)", "#FFFFFF", "#0B1B4D", "#0B1B4D"),
    )


def c04():  # cursor that is a fish: eye + forked tail — sunset / white
    defs = lin("g4", "#FDBA74", "#DB2777", 0, 0, 1, 1)
    cur = (
        "M0 0 L0 520 L130 400 L220 600 L180 700 L268 628 L356 652 L300 565 "
        "L210 370 L380 370 Z"
    )
    return svg(
        "url(#g4)",
        f'<g transform="translate(330 170)"><path d="{cur}" fill="#FFFFFF" stroke="#FFFFFF" '
        f'stroke-width="36" stroke-linejoin="round"/>'
        f'<circle cx="84" cy="200" r="30" fill="#BE185D"/>'
        '</g>',
        defs,
    )


def c05():  # geometric R, bowl carries the disc stripes — black / lime
    lines = "".join(
        f'<line x1="{x}" y1="340" x2="{x}" y2="404" stroke="#0A0A0A" stroke-width="26" stroke-linecap="round"/>'
        for x in (470, 530, 590)
    )
    return svg(
        "#0A0A0A",
        '<path d="M270 812 V212 H580 C720 212 790 300 790 372 C790 444 740 512 650 528 L800 812 H660 '
        'L528 540 H410 V812 Z" fill="#A3E635"/>'
        '<rect x="410" y="316" width="250" height="112" rx="56" fill="#3F6212"/>' + lines,
    )


def c06():  # fish curled into a ring around the target — coral / navy / white
    cx = cy = 512
    r = 250
    a0, a1 = math.radians(-60), math.radians(200)
    p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
    p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
    tx, ty = math.sin(a1), -math.cos(a1)
    base = math.atan2(ty, tx)
    tip = lambda s: (p1[0] + 170 * math.cos(base + s), p1[1] + 170 * math.sin(base + s))
    f1, f2 = tip(math.radians(42)), tip(math.radians(-42))
    notch = (p1[0] + 90 * math.cos(base), p1[1] + 90 * math.sin(base))
    ea = math.radians(-48)
    return svg(
        "#FF6B6B",
        f'<path d="M{p0[0]:.0f} {p0[1]:.0f} A{r} {r} 0 1 1 {p1[0]:.0f} {p1[1]:.0f}" fill="none" '
        f'stroke="#1E293B" stroke-width="130" stroke-linecap="round"/>'
        f'<path d="M{p1[0]:.0f} {p1[1]:.0f} L{f1[0]:.0f} {f1[1]:.0f} L{notch[0]:.0f} {notch[1]:.0f} '
        f'L{f2[0]:.0f} {f2[1]:.0f} Z" fill="#1E293B" stroke="#1E293B" stroke-width="30" stroke-linejoin="round"/>'
        f'<circle cx="{cx + 250 * math.cos(ea):.0f}" cy="{cy + 250 * math.sin(ea):.0f}" r="24" fill="#FFFFFF"/>'
        f'<circle cx="512" cy="512" r="86" fill="#FFFFFF"/>',
    )


def c07():  # pointer with a suction cup tip stuck to a surface — mint light / green / orange
    cur = "M0 0 L0 470 L118 362 L198 540 L272 508 L192 334 L346 334 Z"
    return svg(
        "#ECFDF5",
        '<line x1="160" y1="230" x2="864" y2="230" stroke="#6EE7B7" stroke-width="48" stroke-linecap="round"/>'
        '<path d="M250 236 C250 360 330 400 420 400 C510 400 590 360 590 236 Z" fill="#F97316"/>'
        '<g transform="translate(420 360)"><path d="' + cur + '" fill="#047857" stroke="#047857" '
        'stroke-width="40" stroke-linejoin="round"/></g>',
    )


def c08():  # mascot remora, slight upward swim — cream paper / navy / red
    return svg(
        "#FFF7ED",
        '<path d="M190 760 C330 720 470 760 610 730 C710 708 790 730 850 750" stroke="#FED7AA" '
        'stroke-width="30" fill="none" stroke-linecap="round"/>'
        + remora("translate(512 500) scale(1.08) rotate(-12)", "#1E293B", "#EF4444", "#FFF7ED"),
    )


def c09():  # browser window with remora stuck on its corner — deep teal / amber
    defs = lin("g9", "#14B8A6", "#134E4A")
    return svg(
        "url(#g9)",
        '<rect x="170" y="290" width="620" height="500" rx="64" fill="#F0FDFA"/>'
        '<rect x="170" y="290" width="620" height="110" rx="64" fill="#99F6E4"/>'
        '<rect x="170" y="350" width="620" height="50" fill="#99F6E4"/>'
        '<circle cx="240" cy="345" r="20" fill="#134E4A"/><circle cx="300" cy="345" r="20" fill="#134E4A"/>'
        + remora("translate(700 300) scale(0.6) rotate(-35)", "#FBBF24", "#B45309", "#134E4A"),
        defs,
    )


def c10():  # ultra-minimal two-shape fish mark — pastel pink / magenta
    return svg(
        "#FCE7F3",
        '<path d="M300 512 C300 390 420 320 560 320 C700 320 800 410 820 512 C800 614 700 704 560 704 '
        'C420 704 300 634 300 512 Z" fill="#BE185D"/>'
        '<path d="M330 512 L190 380 L210 512 L190 644 Z" fill="#BE185D" stroke="#BE185D" stroke-width="40" stroke-linejoin="round"/>'
        '<rect x="470" y="336" width="250" height="70" rx="35" fill="#F9A8D4"/>'
        '<circle cx="720" cy="490" r="30" fill="#FCE7F3"/>',
    )


CONCEPTS = [
    ("01-cakram-violet", "Cakram · violet", c01),
    ("02-hiu-ocean", "Remora & hiu · ocean", c02),
    ("03-target-biru", "Menyelam ke target · biru", c03),
    ("04-kursor-sunset", "Kursor-ikan · sunset", c04),
    ("05-r-lime", "Monogram R · lime", c05),
    ("06-cincin-coral", "Ikan melingkar · coral", c06),
    ("07-tempel-mint", "Kursor nempel · mint", c07),
    ("08-maskot-cream", "Maskot · cream", c08),
    ("09-jendela-teal", "Jendela + remora · teal", c09),
    ("10-minimal-pink", "Ikan minimal · pink", c10),
]


def render(art, size):
    return Image.open(io.BytesIO(bytes(svg_to_bytes(svg_string=art, width=size, height=size)))).convert("RGBA")


def main():
    cell_w, cell_h = 420, 330
    sheet = Image.new("RGB", (cell_w * 5, cell_h * 2), "#F4F5F7")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("segoeui.ttf", 18)
        small = ImageFont.truetype("segoeui.ttf", 13)
    except OSError:
        font = small = ImageFont.load_default()
    for i, (slug, label, fn) in enumerate(CONCEPTS):
        art = fn()
        with open(os.path.join(OUT, f"{slug}.svg"), "w", encoding="utf-8") as fh:
            fh.write(art)
        ox, oy = (i % 5) * cell_w, (i // 5) * cell_h
        big = render(art, 220)
        sheet.paste(big, (ox + 20, oy + 20), big)
        for k, size in enumerate((48, 32, 16)):
            x = ox + 256 + k * 52
            for j, bg in enumerate(("#FFFFFF", "#202124")):
                draw.rectangle([x - 4, oy + 20 + j * 70, x + 52, oy + 76 + j * 70], fill=bg)
                im = render(art, size)
                sheet.paste(im, (x + (48 - size) // 2, oy + 24 + j * 70 + (48 - size) // 2), im)
        z = render(art, 16).resize((64, 64), Image.NEAREST)
        sheet.paste(z, (ox + 256, oy + 170), z)
        draw.text((ox + 330, oy + 190), "16px x4", fill="#8B919E", font=small)
        draw.text((ox + 20, oy + 260), f"{slug[:2]} · {label}", fill="#14161C", font=font)
    sheet.save(os.path.join(BASE, "contact-sheet-v3.png"))
    print("ok", OUT)


if __name__ == "__main__":
    main()
