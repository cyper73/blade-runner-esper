"""
ESPER — super-resolution engine
-------------------------------
Real-ESRGAN (RRDBNet, x4) su Apple Silicon/MPS, con fallback classico.

Il principio alchemico: si lavora SEMPRE sul minerale grezzo (il crop
dell'originale), mai sul residuo già trasmutato. Altrimenti si amplifica
la perdita invece dell'informazione.
"""
from __future__ import annotations

import io
import math
import os
import threading
import time
from dataclasses import dataclass, asdict

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:
    import torch
    from torch import nn
    from torch.nn import functional as F

    TORCH_OK = True
except Exception:  # pragma: no cover - ambienti senza torch
    TORCH_OK = False

_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# Remacri è il default: sui dettagli fotografici batte x4plus (che sbaglia le
# lettere) e UltraSharp (che frigge i bordi col ringing). x4plus resta come
# ripiego e si può forzare con ESPER_MODEL=/percorso/modello.pth.
_DEFAULT_MODELS = [
    "4x_foolhardy_Remacri.pth",
    "4x-UltraSharp.pth",
    "RealESRGAN_x4plus.pth",
]
MODEL_PATH = os.environ.get("ESPER_MODEL") or next(
    (os.path.join(_MODELS_DIR, n) for n in _DEFAULT_MODELS
     if os.path.exists(os.path.join(_MODELS_DIR, n))),
    os.path.join(_MODELS_DIR, "RealESRGAN_x4plus.pth"),
)

TILE = 192          # lato del tile in ingresso
TILE_PAD = 16       # sovrapposizione per evitare cuciture
MAX_OUT = 2400      # limite lato output (memoria/VRAM)
MAX_PASSES = 2      # oltre è invenzione pura


# --------------------------------------------------------------------------
# Architettura RRDBNet (compatibile con i pesi ufficiali Real-ESRGAN)
# --------------------------------------------------------------------------
if TORCH_OK:

    class ResidualDenseBlock(nn.Module):
        def __init__(self, num_feat=64, num_grow_ch=32):
            super().__init__()
            self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
            self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
            self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
            self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
            self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

        def forward(self, x):
            x1 = self.lrelu(self.conv1(x))
            x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
            x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
            x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
            x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
            return x5 * 0.2 + x

    class RRDB(nn.Module):
        def __init__(self, num_feat, num_grow_ch=32):
            super().__init__()
            self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
            self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
            self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

        def forward(self, x):
            out = self.rdb1(x)
            out = self.rdb2(out)
            out = self.rdb3(out)
            return out * 0.2 + x

    class RRDBNet(nn.Module):
        def __init__(self, num_in_ch=3, num_out_ch=3, scale=4, num_feat=64,
                     num_block=23, num_grow_ch=32):
            super().__init__()
            self.scale = scale
            if scale == 2:
                num_in_ch *= 4
            elif scale == 1:
                num_in_ch *= 16
            self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
            self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
            self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
            self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
            self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
            self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

        def forward(self, x):
            feat = self.conv_first(x)
            feat = feat + self.conv_body(self.body(feat))
            feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
            feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
            return self.conv_last(self.lrelu(self.conv_hr(feat)))


@dataclass
class EnhanceResult:
    png: bytes
    src_w: int
    src_h: int
    out_w: int
    out_h: int
    factor: float
    passes: int
    ms: int
    device: str
    mode: str
    cache_hit: bool = False

    def meta(self) -> dict:
        d = asdict(self)
        d.pop("png")
        return d


def _pick_device() -> str:
    """mps → cuda → cpu, con override esplicito.

    L'ordine è per velocità reale: Metal su Apple Silicon, CUDA su NVIDIA,
    CPU come ultima spiaggia (lenta ma corretta). `ESPER_DEVICE=cpu|cuda|mps`
    forza la scelta — utile per provare il percorso senza GPU e per non
    dipendere dall'ordine di rilevamento.
    """
    if not TORCH_OK:
        return "cpu"
    want = (os.environ.get("ESPER_DEVICE") or "").strip().lower()
    mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
    has_mps = bool(mps_backend and getattr(mps_backend, "is_available", lambda: False)())
    has_cuda = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())
    if want == "cpu":
        return "cpu"
    if want == "cuda" and has_cuda:
        return "cuda"
    if want == "mps" and has_mps:
        return "mps"
    if has_mps:
        return "mps"
    if has_cuda:
        return "cuda"
    return "cpu"


class EsperEngine:
    """Motore singleton: carica il modello una volta, riusa il device."""

    def __init__(self, model_path: str = MODEL_PATH):
        self.model_path = model_path
        self.lock = threading.Lock()
        self.model = None
        self.device = "cpu"
        self.mode = "classic"
        self.load_error = None
        self._load()

    # -- init ------------------------------------------------------------
    def _load(self):
        if not TORCH_OK:
            self.load_error = "torch non disponibile"
            return
        if not os.path.exists(self.model_path):
            self.load_error = f"pesi non trovati: {self.model_path}"
            return
        try:
            self.device = _pick_device()

            net = RRDBNet(num_in_ch=3, num_out_ch=3, scale=4,
                          num_feat=64, num_block=23, num_grow_ch=32)
            sd = torch.load(self.model_path, map_location="cpu")
            if isinstance(sd, dict) and "params_ema" in sd:
                sd = sd["params_ema"]
            elif isinstance(sd, dict) and "params" in sd:
                sd = sd["params"]
            # I modelli della famiglia ESRGAN (4x-UltraSharp, Remacri, NMKD…)
            # salvano gli stessi tensori con i nomi Basicsr `model.N.*`.
            # Stessa architettura, stesso ORDINE: si rimappa per posizione,
            # ma solo dopo aver verificato che TUTTE le forme coincidano.
            target = net.state_dict()
            if set(sd.keys()) != set(target.keys()):
                sk, tk = list(sd.keys()), list(target.keys())
                if len(sk) == len(tk) and all(sd[a].shape == target[b].shape for a, b in zip(sk, tk)):
                    sd = {b: sd[a] for a, b in zip(sk, tk)}
                else:
                    raise RuntimeError(
                        f"checkpoint incompatibile: {len(sk)} tensori, forme non allineate"
                    )
            net.load_state_dict(sd, strict=True)
            net.eval()
            net = net.to(self.device)
            self.model = net
            self.mode = "realesrgan-x4"
        except Exception as exc:  # pragma: no cover
            self.load_error = f"{type(exc).__name__}: {exc}"
            self.model = None
            self.mode = "classic"

    def status(self) -> dict:
        gb = 0.0
        if TORCH_OK:
            try:
                gb = torch.mps.driver_allocated_memory() / 1e9 if self.device == "mps" else 0.0
            except Exception:
                gb = 0.0
        return {
            "ok": self.model is not None,
            "mode": self.mode,
            "device": self.device,
            "model_path": self.model_path if os.path.exists(self.model_path) else None,
            "torch": torch.__version__ if TORCH_OK else None,
            "error": self.load_error,
            "driver_alloc_gb": round(gb, 2),
        }

    # -- inferenza -------------------------------------------------------
    def _run_tile(self, tensor):
        with torch.inference_mode():
            return self.model(tensor)

    def _upscale_once(self, img: Image.Image) -> Image.Image:
        """Una passata x4 con tiling."""
        arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
        t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(self.device)

        _, _, h, w = t.shape
        out = torch.zeros((1, 3, h * 4, w * 4), dtype=torch.float32, device=self.device)

        for y in range(0, h, TILE):
            for x in range(0, w, TILE):
                y0, y1 = max(0, y - TILE_PAD), min(h, y + TILE + TILE_PAD)
                x0, x1 = max(0, x - TILE_PAD), min(w, x + TILE + TILE_PAD)
                patch = t[:, :, y0:y1, x0:x1]
                with torch.no_grad():
                    res = self._run_tile(patch)
                # ritaglio della parte utile (senza padding)
                gy0 = (y - y0) * 4
                gx0 = (x - x0) * 4
                gh = min(TILE, h - y) * 4
                gw = min(TILE, w - x) * 4
                out[:, :, y * 4:y * 4 + gh, x * 4:x * 4 + gw] = \
                    res[:, :, gy0:gy0 + gh, gx0:gx0 + gw]

        out = out.clamp(0, 1).squeeze(0).permute(1, 2, 0).cpu().numpy()
        return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")

    def _classic(self, img: Image.Image, factor: float) -> Image.Image:
        """Fallback: Lanczos + unsharp + micro-contrasto. Onesto, non generativo."""
        w, h = img.size
        target = (max(1, int(round(w * factor))), max(1, int(round(h * factor))))
        big = img.resize(target, Image.LANCZOS)
        big = big.filter(ImageFilter.UnsharpMask(radius=1.6, percent=140, threshold=2))
        big = ImageEnhance.Contrast(big).enhance(1.06)
        return big

    def enhance(self, img: Image.Image, target_factor: float) -> EnhanceResult:
        """Ingrandisce `img` di circa `target_factor`, con passate x4 reali."""
        t0 = time.time()
        src_w, src_h = img.size
        target_factor = max(1.0, min(16.0, float(target_factor)))
        passes = 0
        out = img

        if self.model is not None and target_factor > 1.35:
            passes = 1 if target_factor <= 4.2 else 2
            passes = min(passes, MAX_PASSES)
            with self.lock:
                for _ in range(passes):
                    if max(out.size) * 4 > MAX_OUT:
                        break
                    out = self._upscale_once(out)
            mode = self.mode
            # rifinitura: se il fattore richiesto non è multiplo di 4
            want_w = int(round(src_w * target_factor))
            want_h = int(round(src_h * target_factor))
            if abs(want_w - out.width) > 2 or abs(want_h - out.height) > 2:
                out = out.resize((want_w, want_h), Image.LANCZOS)
        else:
            out = self._classic(img, target_factor)
            mode = "classic"

        out = out.convert("RGB")
        # restituisce alla GPU la memoria dei buffer intermedi
        if TORCH_OK and self.device == "mps":
            try:
                torch.mps.empty_cache()
            except Exception:
                pass
        buf = _encode_png(out)
        return EnhanceResult(
            png=buf,
            src_w=src_w, src_h=src_h,
            out_w=out.width, out_h=out.height,
            factor=round(out.width / src_w, 3),
            passes=passes,
            ms=int((time.time() - t0) * 1000),
            device=self.device,
            mode=mode,
        )


    def enhance_text(self, img: Image.Image, target_factor: float) -> EnhanceResult:
        """Modalità TESTO: pre-contrasto + TTA orizzontale.

        Real-ESRGAN su lettere di pochi pixel è insicuro: la "S" chiusa viene
        riletta come "O". Il contrasto riporta il tratto alla sua dinamica e la
        media di due orientamenti (originale e specchiato) stabilizza la scelta
        senza inventare nulla di nuovo.
        """
        t0 = time.time()
        src_w, src_h = img.size
        target_factor = max(1.0, min(16.0, float(target_factor)))

        pre = ImageOps.autocontrast(img.convert("RGB"), cutoff=1)
        pre = pre.filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2))

        a = Image.open(io.BytesIO(self.enhance(pre, target_factor).png)).convert("RGB")
        b = Image.open(
            io.BytesIO(self.enhance(pre.transpose(Image.FLIP_LEFT_RIGHT), target_factor).png)
        ).convert("RGB").transpose(Image.FLIP_LEFT_RIGHT)
        if b.size != a.size:
            b = b.resize(a.size, Image.LANCZOS)

        arr = (np.asarray(a, dtype=np.float32) + np.asarray(b, dtype=np.float32)) / 2.0
        out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

        if TORCH_OK and self.device == "mps":
            try:
                torch.mps.empty_cache()
            except Exception:
                pass

        buf = _encode_png(out)
        return EnhanceResult(
            png=buf,
            src_w=src_w, src_h=src_h,
            out_w=out.width, out_h=out.height,
            factor=round(out.width / src_w, 3),
            passes=2,
            ms=int((time.time() - t0) * 1000),
            device=self.device,
            mode="text-tta",
        )


def _encode_png(img: Image.Image) -> bytes:
    import io

    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=False, compress_level=3)
    return bio.getvalue()


ENGINE = None
_ENGINE_LOCK = threading.Lock()


def get_engine() -> EsperEngine:
    global ENGINE
    with _ENGINE_LOCK:
        if ENGINE is None:
            ENGINE = EsperEngine()
        return ENGINE
