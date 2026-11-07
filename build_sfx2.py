"""
Compone i tre suoni d'ambiente della GUI:

  paper.wav  fruscio della fotografia manipolata e inserita
  hum.wav    ronzio continuo della macchina (loop seamless)
  fault.wav  protesta meccanica quando qualcosa non torna

    python build_sfx2.py
"""
from __future__ import annotations

import glob
import os
import wave

import numpy as np
from scipy.signal import butter, sosfilt

ROOT = os.path.dirname(os.path.abspath(__file__))
CAND2 = os.path.join(ROOT, "audio_raw", "candidates2")
CAND1 = os.path.join(ROOT, "audio_raw", "candidates")
OUT = os.path.join(ROOT, "static", "audio")


def read_wav(path: str):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0, sr


def write_wav(path: str, data: np.ndarray, sr: int) -> None:
    pcm = (np.clip(data, -1, 1) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def bp(x, lo, hi, sr, order=4):
    return sosfilt(butter(order, [lo, hi], btype="bandpass", fs=sr, output="sos"), x).astype(np.float32)


def lp(x, f, sr, order=4):
    return sosfilt(butter(order, f, btype="lowpass", fs=sr, output="sos"), x).astype(np.float32)


def hp(x, f, sr, order=4):
    return sosfilt(butter(order, f, btype="highpass", fs=sr, output="sos"), x).astype(np.float32)


def fade(x, sr, ms_in=6.0, ms_out=20.0):
    x = x.copy()
    n = max(1, int(ms_in * 0.001 * sr))
    if len(x) > 2 * n:
        x[:n] *= np.linspace(0, 1, n)
    m = max(1, int(ms_out * 0.001 * sr))
    if len(x) > 2 * m:
        x[-m:] *= np.linspace(1, 0, m)
    return x


def norm(x, peak=0.85):
    p = np.max(np.abs(x)) or 1.0
    return x / p * peak


def resample(x, factor: float):
    """factor < 1 → più lungo e più grave."""
    n = max(1, int(len(x) * factor))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def make_loop(path: str, out_path: str, seconds=8.0, xfade=0.8) -> None:
    x, sr = read_wav(path)
    n = int(seconds * sr)
    seg = x[:n].copy()
    seg = hp(seg, 45, sr, 2)
    seg = lp(seg, 6000, sr, 2)
    k = int(xfade * sr)
    head = seg[:k].copy()
    tail = seg[-k:].copy()
    w = np.linspace(0, 1, k).astype(np.float32)
    body = seg[:-k].copy()
    body[:k] = body[:k] * w + tail * (1 - w)
    # normalizza morbido: il ronzio deve stare sotto, non protagonista
    body = norm(body, 0.5)
    write_wav(out_path, body.astype(np.float32), sr)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    # ── fruscio: due eventi di carta in sequenza ────────────────────────
    s2 = glob.glob(os.path.join(CAND2, "soft_02_*.wav"))[0]
    s3 = glob.glob(os.path.join(CAND2, "soft_03_*.wav"))[0]
    a, sr = read_wav(s2)
    b, _ = read_wav(s3)
    # morbido: banda stretta, livello basso, attacco graduale
    a = bp(a, 480, 6000, sr)
    b = bp(b, 480, 6000, sr)
    a = norm(a, 0.5)
    b = norm(b, 0.32)
    gap = np.zeros(int(0.09 * sr), dtype=np.float32)
    paper = np.concatenate([fade(a, sr, 12, 45), gap, fade(b, sr, 14, 90)])
    paper = fade(paper, sr, 8, 160)
    write_wav(os.path.join(OUT, "paper.wav"), paper, sr)

    # ── ronzio ──────────────────────────────────────────────────────────
    hum_src = sorted(glob.glob(os.path.join(CAND2, "hum_1_*.wav")))
    if hum_src:
        # il file hum è di 6 s: ne servono 8, quindi lo ripeto prima del loop
        x, _ = read_wav(hum_src[0])
        long = np.concatenate([x, x])
        tmp = os.path.join(CAND2, "_hum_long.wav")
        write_wav(tmp, long, sr)
        make_loop(tmp, os.path.join(OUT, "hum.wav"), seconds=8.0, xfade=0.9)

    # ── guasto: click rallentato, cupo, ripetuto ────────────────────────
    c13 = glob.glob(os.path.join(CAND1, "cand_13_*.wav"))[0]
    x, sr = read_wav(c13)
    x = norm(x, 0.9)
    low = resample(x, 0.55)
    low = lp(low, 1400, sr)
    low = hp(low, 70, sr, 2)
    low = norm(low, 0.75)
    second = resample(x, 0.42)
    second = lp(second, 900, sr)
    second = norm(second, 0.55)
    gap = np.zeros(int(0.09 * sr), dtype=np.float32)
    fault = np.concatenate([fade(low, sr, 3, 120), gap, fade(second, sr, 3, 160)])
    write_wav(os.path.join(OUT, "fault.wav"), fault, sr)

    for n in ("paper", "hum", "fault"):
        p = os.path.join(OUT, n + ".wav")
        y, srr = read_wav(p)
        print(f"{n:7s} {len(y)/srr:6.2f} s  {os.path.getsize(p)/1024:6.1f} KB")


if __name__ == "__main__":
    main()
