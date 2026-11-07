"""Confronto A/B tra upscaler sulla stessa porzione di foto.

Carica un modello alla volta (la GPU MPS è una sola), salva i risultati 4x
affiancati al nearest, così il giudizio è onesto: si vede cosa il modello
aggiunge rispetto ai pixel veri.
"""
from __future__ import annotations

import gc
import io
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw  # noqa: E402

from esper_engine import EsperEngine  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "shots" / "model_compare"
OUT.mkdir(parents=True, exist_ok=True)

# Il cartello SONY: testo + bordi netti, il caso più difficile.
SRC = ROOT / "static" / "assets" / "prodest.jpg"
CROPS = {
    "sony": (270, 55, 410, 145),      # 140x90  → 560x360
    "dettaglio": (60, 180, 340, 360),  # 280x180 → 1120x720
}

MODELS = [
    ("x4plus", ROOT / "models" / "RealESRGAN_x4plus.pth"),
    ("ultrasharp", ROOT / "models" / "4x-UltraSharp.pth"),
    ("remacri", ROOT / "models" / "4x_foolhardy_Remacri.pth"),
]


def load_engine(path: Path) -> EsperEngine:
    eng = EsperEngine(str(path))
    if eng.model is None:
        raise SystemExit(f"{path.name}: {eng.load_error}")
    return eng


def main() -> None:
    src = Image.open(SRC).convert("RGB")
    for cname, box in CROPS.items():
        crop = src.crop(box)
        nearest = crop.resize((crop.width * 4, crop.height * 4), Image.NEAREST)
        tiles = [("NEAREST", nearest)]
        for label, path in MODELS:
            t0 = time.time()
            eng = load_engine(path)
            res = eng.enhance(crop, 4.0)
            img = Image.open(io.BytesIO(res.png)).convert("RGB")
            dt = time.time() - t0
            print(f"{cname} / {label}: {crop.width}x{crop.height} -> {img.width}x{img.height} in {dt:.2f}s")
            tiles.append((label.upper(), img))
            del eng
            gc.collect()
            try:
                import torch

                torch.mps.empty_cache()
            except Exception:
                pass
        # pannello orizzontale, etichette sopra ogni riquadro
        w = max(t.width for _, t in tiles)
        h = max(t.height for _, t in tiles) + 22
        panel = Image.new("RGB", (w * len(tiles), h), (10, 12, 14))
        d = ImageDraw.Draw(panel)
        for i, (label, t) in enumerate(tiles):
            panel.paste(t, (i * w, 22))
            d.text((i * w + 6, 6), label, fill=(150, 240, 255))
        panel.save(OUT / f"compare_{cname}.png")
        print("salvato", OUT / f"compare_{cname}.png")


if __name__ == "__main__":
    main()
