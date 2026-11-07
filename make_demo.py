"""
Genera il caso 01: una foto notturna CC0 con un dettaglio inciso
che a piena vista è solo rumore, e a 4× diventa leggibile.

    python make_demo.py
"""
from __future__ import annotations

import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "assets", "source_cc0.jpg")
OUT = os.path.join(ROOT, "assets", "demo_zhora.jpg")

# coordinate dell'incisione (fascia bianca libera sotto "EVENTS")
TAG_XY = (340, 126)
TAG_TEXT = "ZHORA — NEXUS 6"
TAG_SUB = ""


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Menlo.ttc",
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def grade(img: Image.Image) -> Image.Image:
    """Notte, contrasto, vignettatura, grana: un negativo che ha vissuto."""
    img = ImageEnhance.Brightness(img).enhance(0.92)
    img = ImageEnhance.Contrast(img).enhance(1.14)
    img = ImageEnhance.Color(img).enhance(1.08)

    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w * 0.52, h * 0.48
    r = np.sqrt(((xx - cx) / (w * 0.72)) ** 2 + ((yy - cy) / (h * 0.78)) ** 2)
    vig = np.clip(1.0 - 0.42 * np.clip(r - 0.35, 0, None) ** 1.35, 0.35, 1.0)[..., None]
    arr = np.asarray(img).astype(np.float32) * vig

    # grana
    rng = np.random.default_rng(2019)
    grain = rng.normal(0, 4.2, (h, w, 1))
    arr = np.clip(arr + grain, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def incise(img: Image.Image) -> Image.Image:
    """Il dettaglio: due righe tipografiche minuscole, consumate."""
    d = ImageDraw.Draw(img)
    x, y = TAG_XY
    d.text((x, y), TAG_TEXT, font=font(8), fill=(46, 46, 42))
    if TAG_SUB:
        d.text((x + 1, y + 14), TAG_SUB, font=font(8), fill=(52, 52, 48))
    # consumato dalla stampa: appena sfumato
    return img.filter(ImageFilter.GaussianBlur(0.45))


def main() -> None:
    src = Image.open(SRC).convert("RGB")
    out = incise(grade(src))
    out.save(OUT, "JPEG", quality=91, optimize=True, progressive=True)
    print(f"wrote {OUT} {out.size} {os.path.getsize(OUT)/1024:.0f} KB")

    # anteprima del dettaglio: come appare a 1x e a 4x (Lanczos, senza AI)
    box = (TAG_XY[0] - 26, TAG_XY[1] - 16, TAG_XY[0] + 92, TAG_XY[1] + 34)
    crop = out.crop(box)
    crop.resize((crop.width * 4, crop.height * 4), Image.LANCZOS).save(
        os.path.join(ROOT, "shots", "detail_ref_4x.png")
    )
    crop.save(os.path.join(ROOT, "shots", "detail_ref_1x.png"))


if __name__ == "__main__":
    main()
