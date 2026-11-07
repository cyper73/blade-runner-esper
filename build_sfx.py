"""
Compone i quattro effetti della GUI a partire dai transienti estratti
dal film: zoom, selezione zona, scatto (hard copy), enhance.

    python build_sfx.py
"""
from __future__ import annotations

import glob
import os

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "static", "audio")
OUT = os.path.join(ROOT, "static", "audio")


def read_wav(path: str):
    import wave
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return a, sr


def write_wav(path: str, data: np.ndarray, sr: int) -> None:
    import wave
    pcm = (np.clip(data, -1, 1) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def stats(x: np.ndarray, sr: int) -> dict:
    peak = float(np.max(np.abs(x)))
    # inviluppo a 1ms
    win = max(1, int(0.001 * sr))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode="same")
    thr = env.max() * 0.1
    above = np.where(env > thr)[0]
    dur = (above[-1] - above[0]) / sr if len(above) else 0.0
    rms = float(np.sqrt(np.mean(x ** 2)))
    return {"peak": peak, "rms": rms, "dur_ms": round(dur * 1000, 1),
            "len_ms": round(len(x) / sr * 1000, 1)}


def normalize(x: np.ndarray, target=0.85) -> np.ndarray:
    p = np.max(np.abs(x)) or 1.0
    return x / p * target


def fade(x: np.ndarray, sr: int, ms=3.0) -> np.ndarray:
    n = max(1, int(ms * 0.001 * sr))
    x = x.copy()
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    return x


def trim_silence(x: np.ndarray, sr: int, thresh=0.02, pad_ms=8) -> np.ndarray:
    env = np.abs(x)
    idx = np.where(env > thresh)[0]
    if not len(idx):
        return x
    pad = int(pad_ms * 0.001 * sr)
    a = max(0, idx[0] - pad)
    b = min(len(x), idx[-1] + pad)
    return x[a:b]


def main() -> None:
    cands = {}
    for f in glob.glob(os.path.join(SRC, "cand_*.wav")):
        t = float(os.path.basename(f).split("_t")[1].split("_")[0])
        cands[round(t, 2)] = f

    print("candidati disponibili:", len(cands))
    for t in sorted(cands):
        x, sr = read_wav(cands[t])
        s = stats(x, sr)
        print(f"  t={t:7.2f}  len={s['len_ms']:6.1f}ms  event={s['dur_ms']:6.1f}ms  "
              f"rms={s['rms']:.3f}")

    def get(t: float) -> np.ndarray:
        x, sr = read_wav(cands[t])
        return trim_silence(x, sr), sr

    # ── i quattro caratteri ──────────────────────────────────────────────
    # selezione: click secco e acuto
    sel, sr = get(90.20)
    sel = fade(normalize(sel, 0.8), sr, 2)

    # zoom: click più corposo, con la coda del meccanismo
    zoom, sr = get(94.41)
    zoom = fade(normalize(zoom, 0.9), sr, 2)

    # enhance: click + breve ronzio discendente (la macchina "prende" il dettaglio)
    enh, sr = get(95.91)
    enh = fade(normalize(enh, 0.85), sr, 2)

    # scatto/hard copy: due scatti in sequenza, come l'otturatore + l'avanzamento
    c1, sr = get(109.44)
    c2, sr = get(108.80)
    c1 = fade(normalize(c1, 0.9), sr, 1.5)
    c2 = fade(normalize(c2, 0.55), sr, 1.5)
    gap = np.zeros(int(0.075 * sr), dtype=np.float32)
    shutter = np.concatenate([c1, gap, c2])
    shutter = fade(shutter, sr, 3)

    write_wav(os.path.join(OUT, "select.wav"), sel, sr)
    write_wav(os.path.join(OUT, "zoom.wav"), zoom, sr)
    write_wav(os.path.join(OUT, "enhance.wav"), enh, sr)
    write_wav(os.path.join(OUT, "shutter.wav"), shutter, sr)

    # anteprima per l'ascolto: 0.8 s tra i suoni
    preview = []
    for name in ("select", "zoom", "enhance", "shutter"):
        x, srr = read_wav(os.path.join(OUT, name + ".wav"))
        preview.append(x)
        preview.append(np.zeros(int(0.8 * srr), dtype=np.float32))
    write_wav(os.path.join(OUT, "_preview.wav"), np.concatenate(preview), sr)

    for name in ("select", "zoom", "enhance", "shutter", "_preview"):
        p = os.path.join(OUT, name + ".wav")
        x, srr = read_wav(p)
        print(f"{name:9s} {len(x)/srr*1000:6.0f} ms  {os.path.getsize(p)/1024:5.1f} KB")


if __name__ == "__main__":
    main()
