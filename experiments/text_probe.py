"""Banco di prova: come si comporta Real-ESRGAN su una scritta piccola (SONY).

Confronta varianti sullo stesso dettaglio e salva un pannello leggibile.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from esper_engine import get_engine  # noqa: E402

SRC = Path("/Users/cypermac1/Pictures/prodest+ù.jpeg")
OUT = Path(__file__).resolve().parent / "shots" / "text_probe"
OUT.mkdir(parents=True, exist_ok=True)

# zona della scritta SONY sullo sfondo (dalla foto 1600x900)
TIGHT = (297, 80, 382, 121)     # 85 x 41
WIDE = (250, 48, 470, 168)      # 220 x 120, con contesto


def run(engine, img: Image.Image, factor: float) -> Image.Image:
    """L'engine restituisce PNG: qui lo riportiamo a Image."""
    res = engine.enhance(img, factor)
    return Image.open(io.BytesIO(res.png)).convert("RGB")


def label(img: Image.Image, text: str) -> Image.Image:
    from PIL import ImageDraw
    pad = 26
    canvas = Image.new("RGB", (img.width, img.height + pad), (8, 10, 12))
    canvas.paste(img.convert("RGB"), (0, pad))
    d = ImageDraw.Draw(canvas)
    d.text((6, 7), text, fill=(150, 230, 255))
    return canvas


def tta(engine, box: Image.Image, target: int) -> Image.Image:
    """Media di quattro orientamenti: riduce le allucinazioni del modello."""
    acc = None
    for fl in (False, True):
        for fv in (False, True):
            v = box.transpose(Image.FLIP_LEFT_RIGHT) if fl else box
            v = v.transpose(Image.FLIP_TOP_BOTTOM) if fv else v
            r = run(engine, v, target)
            if fl:
                r = r.transpose(Image.FLIP_LEFT_RIGHT)
            if fv:
                r = r.transpose(Image.FLIP_TOP_BOTTOM)
            r = r.convert("RGB")
            if acc is not None:
                want = (acc.shape[1], acc.shape[0])
                if r.size != want:
                    r = r.resize(want, Image.LANCZOS)
            a = np.asarray(r, dtype=np.float32)
            acc = a if acc is None else acc + a
    return Image.fromarray(np.clip(acc / 4.0, 0, 255).astype(np.uint8))


def main() -> None:
    engine = get_engine()
    im = Image.open(SRC).convert("RGB")

    tight = im.crop(TIGHT)
    wide = im.crop(WIDE)

    # 1) come la vede l'occhio: nearest 8x
    near = tight.resize((tight.width * 8, tight.height * 8), Image.NEAREST)

    # 2) baseline AI sullo stretto
    base = run(engine, tight, 8.0)

    # 3) AI con contesto (più struttura attorno alle lettere)
    ctx = run(engine, wide, 4.0)

    # 4) pre-contrasto + unsharp, poi AI
    pre = ImageOps.autocontrast(tight, cutoff=1)
    pre = pre.filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2))
    pre_ai = run(engine, pre, 8.0)

    # 5) TTA (4 orientamenti)
    tta_ai = tta(engine, tight, 8.0)

    # 6) AI 4x + Lanczos 2x (meno invenzione, più interpolazione)
    half = run(engine, tight, 4.0)
    half = half.resize((tight.width * 8, tight.height * 8), Image.LANCZOS)

    panels = [
        ("NEAREST 8x (verita dei pixel)", near),
        ("AI 8x (baseline)", base),
        ("AI 4x CON CONTESTO", ctx),
        ("PRE-CONTRASTO + AI", pre_ai),
        ("TTA 4 orientamenti", tta_ai),
        ("AI 4x + LANCZOS", half),
    ]

    # griglia 3x2, ogni cella 760 px: leggibile anche dopo il downscaling
    CW, CH = 760, 420
    cols, rows = 3, 2
    sheet = Image.new("RGB", (cols * CW + 16 * (cols + 1), rows * (CH + 30) + 16), (8, 10, 12))
    for i, (name, img) in enumerate(panels):
        c, r = i % cols, i // cols
        thumb = img.copy()
        thumb.thumbnail((CW, CH), Image.LANCZOS)
        cell = label(thumb, name)
        x = 16 + c * (CW + 16)
        y = 16 + r * (CH + 30 + 16)
        sheet.paste(cell, (x, y))
    sheet.save(OUT / "panel.png")
    print("pannello:", OUT / "panel.png", sheet.size)

    # salva anche i singoli con nomi leggibili
    for i, (name, img) in enumerate(panels):
        img.save(OUT / f"{i}_{name.split()[0].lower().replace('+','_')}.png")
    print("fatto")


if __name__ == "__main__":
    main()
