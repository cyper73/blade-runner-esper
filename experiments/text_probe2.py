"""Varianti TTA sul dettaglio SONY: orizzontale, verticale, con pre e post.

Obiettivo: capire quale combinazione costa poco e conserva la S.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from esper_engine import get_engine  # noqa: E402

SRC = Path("/Users/cypermac1/Pictures/prodest+ù.jpeg")
OUT = Path(__file__).resolve().parent / "shots" / "text_probe"
OUT.mkdir(parents=True, exist_ok=True)
TIGHT = (297, 80, 382, 121)
SCALE = 8


def run(engine, img, factor):
    return Image.open(io.BytesIO(engine.enhance(img, factor).png)).convert("RGB")


def tta(engine, box, target, flips=("h",)):
    acc = None
    variants = [("", False, False)]
    if "h" in flips:
        variants.append(("h", True, False))
    if "v" in flips:
        variants.append(("v", False, True))
    if "h" in flips and "v" in flips:
        variants.append(("hv", True, True))
    for _, fh, fv in variants:
        v = box.transpose(Image.FLIP_LEFT_RIGHT) if fh else box
        v = v.transpose(Image.FLIP_TOP_BOTTOM) if fv else v
        r = run(engine, v, target)
        if fh:
            r = r.transpose(Image.FLIP_LEFT_RIGHT)
        if fv:
            r = r.transpose(Image.FLIP_TOP_BOTTOM)
        a = np.asarray(r, dtype=np.float32)
        if acc is not None and a.shape != acc.shape:
            a = np.asarray(r.resize((acc.shape[1], acc.shape[0]), Image.LANCZOS), dtype=np.float32)
        acc = a if acc is None else acc + a
    return Image.fromarray(np.clip(acc / len(variants), 0, 255).astype(np.uint8))


def main():
    engine = get_engine()
    im = Image.open(SRC).convert("RGB")
    tight = im.crop(TIGHT)

    pre = ImageOps.autocontrast(tight, cutoff=1).filter(
        ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2)
    )

    out = {}
    out["6_tta_h"] = tta(engine, tight, SCALE, ("h",))
    out["7_tta_v"] = tta(engine, tight, SCALE, ("v",))
    out["8_tta_hv_pre"] = tta(engine, pre, SCALE, ("h", "v"))
    h = out["6_tta_h"].filter(ImageFilter.UnsharpMask(radius=1.0, percent=80, threshold=1))
    out["9_tta_h_post"] = h
    out["10_tta_h_pre"] = tta(engine, pre, SCALE, ("h",))

    for name, img in out.items():
        img.save(OUT / f"{name}.png")
        print(name, img.size)


if __name__ == "__main__":
    main()
