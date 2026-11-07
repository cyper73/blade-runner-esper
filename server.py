"""
ESPER — local analysis server
-----------------------------
Serve la GUI e l'API di super-resolution. Nessun dato esce dalla macchina:
il "mainframe" è il tuo Mac mini.

    python server.py            # http://127.0.0.1:8777
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from typing import Dict, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from esper_engine import get_engine

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
ASSETS = os.path.join(ROOT, "assets")

app = FastAPI(title="ESPER Photo Analysis", version="1.0")


@app.middleware("http")
async def _no_store(request, call_next):
    """In locale gli asset cambiano di continuo: la cache del browser serve solo
    a mostrare una GUI vecchia con un motore nuovo. Vietata."""
    resp = await call_next(request)
    p = request.url.path
    if p in ("/", "/index.html") or p.startswith("/static"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
    return resp

MAX_SIDE = 6000          # oltre, l'immagine viene ridotta (memoria)
MAX_PHOTOS = 4           # foto tenute in memoria
PREVIEW_MAX = 2200       # lato massimo della preview inviata al browser
TILE_CACHE_SIZE = 48

_photos: "OrderedDict[str, dict]" = OrderedDict()
_photo_lock = threading.Lock()
_tiles: "OrderedDict[str, bytes]" = OrderedDict()
_tile_lock = threading.Lock()


# --------------------------------------------------------------------------
# store foto
# --------------------------------------------------------------------------
def _remember(pid: str, img: Image.Image, name: str) -> dict:
    rec = {"img": img, "name": name, "w": img.width, "h": img.height, "t": time.time()}
    with _photo_lock:
        _photos[pid] = rec
        _photos.move_to_end(pid)
        while len(_photos) > MAX_PHOTOS:
            _photos.popitem(last=False)
    return rec


def _get_photo(pid: str) -> dict:
    with _photo_lock:
        rec = _photos.get(pid)
        if rec is None:
            raise HTTPException(404, "photo not in memory — reinsert the file")
        _photos.move_to_end(pid)
        return rec


def _as_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (8, 10, 10))
        rgba = img.convert("RGBA")
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return img.convert("RGB")


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
WHISPER_BIN = (
    os.environ.get("WHISPER_BIN")
    or shutil.which("whisper-cli")
    or shutil.which("whisper-cpp")
    or shutil.which("main")
    or ""
)
WHISPER_MODEL = os.environ.get(
    "WHISPER_MODEL", os.path.join(ROOT, "models", "whisper", "ggml-small.bin")
)
FFMPEG_BIN = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"

# Niente prompt di biasing: misurato, su frasi brevi whisper prova a completarlo
# e allucina ("E' un'altra venace" per "enhance"). Il vocabolario fonetico a
# valle fa il lavoro meglio, senza introdurre testo inventato.
WHISPER_PROMPT = ""


def whisper_ready() -> bool:
    return bool(WHISPER_BIN) and os.path.exists(WHISPER_MODEL)


@app.get("/api/status")


def api_status():
    st = get_engine().status()
    st["whisper"] = whisper_ready()
    st["whisper_model"] = os.path.basename(WHISPER_MODEL) if whisper_ready() else None
    return st


def _exif_dict(raw: bytes) -> dict:
    """Estrae i metadati leggibili dalla foto originale.

    Si riapre il file: `_as_rgb` e la trasposizione possono lasciare
    l'oggetto senza i tag. Restituisce solo campi già formattati, così la
    GUI non deve conoscere i codici EXIF.
    """
    try:
        src = Image.open(io.BytesIO(raw))
        ex = src.getexif()
    except Exception:
        return {}
    if not ex:
        return {}
    try:
        ifd = ex.get_ifd(0x8769) or {}
    except Exception:
        ifd = {}
    try:
        gps = ex.get_ifd(0x8825) or {}
    except Exception:
        gps = {}

    def txt(tag, table=None):
        v = (table or ex).get(tag)
        return str(v).strip() if v else ""

    out = {}
    for key, tag in (("make", 271), ("model", 272), ("software", 305), ("lens", 42036)):
        v = txt(tag, ifd if tag == 42036 else ex)
        if v:
            out[key] = v

    dt = str(ifd.get(36867) or ex.get(306) or "").strip()
    if dt:
        # "2024:03:18 14:22:07" → "2024-03-18 14:22:07"
        out["date"] = dt.replace(":", "-", 2) if dt[4:5] == ":" else dt

    iso = ifd.get(34855)
    if iso:
        out["iso"] = f"ISO {iso}"
    fn = ifd.get(33437)
    if fn:
        try:
            out["aperture"] = f"f/{float(fn):g}"
        except Exception:
            pass
    et = ifd.get(33434)
    if et:
        try:
            et = float(et)
            out["shutter"] = f"1/{round(1 / et)} s" if 0 < et < 1 else f"{et:g} s"
        except Exception:
            pass
    fl = ifd.get(37386)
    if fl:
        try:
            out["focal"] = f"{float(fl):g} mm"
        except Exception:
            pass

    def dms(v):
        try:
            d, m, sec = (float(x) for x in v)
            return d + m / 60 + sec / 3600
        except Exception:
            return None

    lat, lon = dms(gps.get(2)), dms(gps.get(4))
    if lat is not None and lon is not None:
        if str(gps.get(1, "N")).upper().startswith("S"):
            lat = -lat
        if str(gps.get(3, "E")).upper().startswith("W"):
            lon = -lon
        out["gps"] = f"{lat:.5f}, {lon:.5f}"
    return out


@app.post("/api/photo")
async def api_photo(file: UploadFile = File(...)):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        img.load()
        img = _as_rgb(img)
    except Exception as exc:
        raise HTTPException(400, f"unreadable image: {exc}")

    scaled = False
    if max(img.size) > MAX_SIDE:
        ratio = MAX_SIDE / max(img.size)
        img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
        scaled = True

    pid = uuid.uuid4().hex[:12]
    rec = _remember(pid, img, file.filename or "untitled")
    return {
        "id": pid,
        "name": rec["name"],
        "w": img.width,
        "h": img.height,
        "bytes": len(raw),
        "downscaled": scaled,
        "format": (Image.open(io.BytesIO(raw)).format or "").upper(),
        "exif": _exif_dict(raw),
    }


@app.post("/api/voice")
async def api_voice(audio: UploadFile = File(...), lang: str = "it"):
    """Trascrizione **locale** con whisper.cpp: l'audio non lascia il Mac."""
    if not whisper_ready():
        raise HTTPException(503, "whisper.cpp non disponibile (binario o modello mancante)")
    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio")

    t0 = time.time()
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "in.bin")
        dst = os.path.join(td, "out.wav")
        with open(src, "wb") as fh:
            fh.write(raw)
        try:
            subprocess.run(
                [FFMPEG_BIN, "-y", "-loglevel", "error", "-i", src,
                 "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst],
                check=True, capture_output=True, timeout=30,
            )
        except Exception as exc:
            raise HTTPException(400, f"audio non decodificabile: {exc}") from exc

        outbase = os.path.join(td, "tr")
        cmd = [
            WHISPER_BIN, "-m", WHISPER_MODEL, "-f", dst,
            "-l", "it" if lang.lower().startswith("it") else "en",
            "-nt", "-otxt", "-of", outbase, "-t", "4", "-sns",
        ]
        if WHISPER_PROMPT:
            cmd += ["--prompt", WHISPER_PROMPT]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, "trascrizione troppo lenta") from exc

        text = ""
        txt = outbase + ".txt"
        if os.path.exists(txt):
            with open(txt, encoding="utf-8") as fh:
                text = fh.read().strip()
        if not text:
            text = (proc.stdout or "").strip()

    return {
        "text": text,
        "ms": int((time.time() - t0) * 1000),
        "model": os.path.basename(WHISPER_MODEL),
    }


@app.get("/api/photo/{pid}/preview.jpg")
def api_preview(pid: str, w: int = PREVIEW_MAX):
    rec = _get_photo(pid)
    img = rec["img"]
    w = max(240, min(3000, w))
    if img.width > w:
        ratio = w / img.width
        img = img.resize((w, max(1, int(img.height * ratio))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92, optimize=True, progressive=True)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=600", "X-Native": f"{rec['w']}x{rec['h']}"},
    )


class EnhanceRequest(BaseModel):
    id: str
    x: float
    y: float
    w: float
    h: float
    out_w: Optional[int] = None
    factor: Optional[float] = None
    text: bool = False


@app.post("/api/enhance")
def api_enhance(req: EnhanceRequest):
    rec = _get_photo(req.id)
    src: Image.Image = rec["img"]
    W, H = src.size

    # clamp del rettangolo richiesto
    x = max(0.0, min(float(req.x), W - 2))
    y = max(0.0, min(float(req.y), H - 2))
    w = max(8.0, min(float(req.w), W - x))
    h = max(8.0, min(float(req.h), H - y))

    crop_box = (int(round(x)), int(round(y)), int(round(x + w)), int(round(y + h)))
    cw, ch = crop_box[2] - crop_box[0], crop_box[3] - crop_box[1]
    if cw < 8 or ch < 8:
        raise HTTPException(400, "selection too small")

    wanted = None
    if req.out_w:
        wanted = float(req.out_w) / float(cw)
    elif req.factor:
        wanted = float(req.factor)
    factor = max(1.0, min(16.0, wanted if wanted else 1.0))

    crop = src.crop(crop_box)

    # il modello FA parte della chiave: senza, cambiando upscaler la cache
    # restituisce il risultato del modello precedente (bug visto con Remacri)
    _model_tag = os.path.basename(get_engine().model_path or "none")
    key = hashlib.sha1(
        f"{req.id}|{crop_box}|{factor:.3f}|{src.size}|{'t' if req.text else 'a'}|{_model_tag}".encode()
    ).hexdigest()
    with _tile_lock:
        cached = _tiles.get(key)
        if cached is not None:
            _tiles.move_to_end(key)
    if cached is not None:
        return JSONResponse(
            {
                "image": "data:image/png;base64," + base64.b64encode(cached).decode(),
                "meta": {
                    "rect": crop_box, "factor": round(factor, 3),
                    "src_w": cw, "src_h": ch,
                    "out_w": int(cw * factor), "out_h": int(ch * factor),
                    "ms": 0, "mode": "cache", "device": get_engine().device,
                    "passes": 0, "cache_hit": True,
                },
            }
        )

    result = get_engine().enhance_text(crop, factor) if req.text else get_engine().enhance(crop, factor)
    with _tile_lock:
        _tiles[key] = result.png
        _tiles.move_to_end(key)
        while len(_tiles) > TILE_CACHE_SIZE:
            _tiles.popitem(last=False)

    meta = result.meta()
    meta["rect"] = crop_box
    return JSONResponse(
        {
            "image": "data:image/png;base64," + base64.b64encode(result.png).decode(),
            "meta": meta,
        }
    )


@app.get("/api/photo/{pid}/native")
def api_native(pid: str):
    """Byte dell'immagine pura (per hard copy senza HUD, se serve)."""
    rec = _get_photo(pid)
    buf = io.BytesIO()
    rec["img"].save(buf, "PNG", compress_level=3)
    return Response(buf.getvalue(), media_type="image/png")


@app.get("/api/photo/{pid}/info")
def api_info(pid: str):
    rec = _get_photo(pid)
    return {"id": pid, "name": rec["name"], "w": rec["w"], "h": rec["h"]}


@app.post("/api/demo")
def api_demo():
    """Carica il caso 01 dalla cartella assets, se presente."""
    path = os.path.join(ASSETS, "demo_zhora.jpg")
    if not os.path.exists(path):
        raise HTTPException(404, "demo asset missing")
    img = _as_rgb(Image.open(path))
    pid = uuid.uuid4().hex[:12]
    _remember(pid, img, "CASE FILE 01 — ZHORA")
    return {"id": pid, "name": "CASE FILE 01 — ZHORA", "w": img.width, "h": img.height,
            "bytes": os.path.getsize(path), "downscaled": False}


@app.get("/")
def root():
    return FileResponse(os.path.join(STATIC, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8777, log_level="info")
