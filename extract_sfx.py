"""
Estrae gli effetti sonori dalla scena Esper di Blade Runner.

Cerca transienti brevi e a banda larga (click meccanici della macchina)
dentro la sequenza in cui Deckard usa l'Esper, li ritaglia e ne salva
campioni normalizzati + uno spettrogramma per la verifica a occhio.

    python extract_sfx.py
"""
from __future__ import annotations

import os
import wave

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "audio_raw", "scene.wav")
OUT = os.path.join(ROOT, "static", "audio")
SHOTS = os.path.join(ROOT, "shots", "sfx")

# finestra della scena (secondi) — l'Esper entra intorno a 0:55
T0, T1 = 50.0, 115.0
N_FFT = 1024
HOP = 256


def read_wav(path: str):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        a = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, sr


def write_wav(path: str, data: np.ndarray, sr: int) -> None:
    pcm = (np.clip(data, -1, 1) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def highpass(x: np.ndarray, sr: int, fc: float = 600.0) -> np.ndarray:
    """Passa-alto: toglie ronzio, rombo e la parte grave della musica."""
    try:
        from scipy.signal import butter, sosfilt
        sos = butter(4, fc, btype="highpass", fs=sr, output="sos")
        return sosfilt(sos, x).astype(np.float32)
    except Exception:
        rc = 1.0 / (2 * np.pi * fc)
        dt = 1.0 / sr
        alpha = rc / (rc + dt)
        y = np.empty_like(x)
        prev_x = prev_y = 0.0
        for i in range(len(x)):
            prev_y = alpha * (prev_y + x[i] - prev_x)
            prev_x = x[i]
            y[i] = prev_y
        return y


def stft_mag(x: np.ndarray):
    frames = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP]
    win = np.hanning(N_FFT).astype(np.float32)
    spec = np.abs(np.fft.rfft(frames * win, axis=1))
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / 44100)
    return spec, freqs


def find_onsets(x: np.ndarray, sr: int):
    spec, freqs = stft_mag(x)
    hi = (freqs >= 3000) & (freqs <= 13000)
    mid = (freqs >= 300) & (freqs < 3000)
    e_hi = (spec[:, hi] ** 2).sum(axis=1) + 1e-9
    e_mid = (spec[:, mid] ** 2).sum(axis=1) + 1e-9
    e_all = e_hi + e_mid + 1e-9

    # forza d'onset: crescita dell'energia alta
    d = np.diff(np.log(e_hi), prepend=np.log(e_hi[0]))
    strength = np.maximum(d, 0.0)

    # soglia adattiva
    from scipy.ndimage import median_filter
    k = 41
    med = median_filter(strength, size=k, mode="nearest")
    mad = median_filter(np.abs(strength - med), size=k, mode="nearest")
    thr = med + 6.0 * np.maximum(mad, 1e-4)
    cand = np.where(strength > thr)[0]

    # non-max suppression a 180 ms
    min_gap = int(0.18 * sr / HOP)
    picked = []
    for c in cand[np.argsort(strength[cand])[::-1]]:
        if all(abs(c - p) > min_gap for p in picked):
            picked.append(int(c))
    picked.sort()

    out = []
    for f in picked:
        t = f * HOP / sr
        if not (T0 <= t <= T1):
            continue
        band_ratio = float(e_hi[f] / e_all[f])
        out.append({
            "t": t,
            "strength": float(strength[f]),
            "band": band_ratio,
        })
    return out


def cut(x: np.ndarray, sr: int, t: float, pre=0.09, post=0.26) -> np.ndarray:
    a = max(0, int((t - pre) * sr))
    b = min(len(x), int((t + post) * sr))
    seg = x[a:b].copy()
    # fade per non fare "pop"
    n = max(1, int(0.004 * sr))
    seg[:n] *= np.linspace(0, 1, n)
    seg[-n:] *= np.linspace(1, 0, n)
    peak = np.max(np.abs(seg)) or 1.0
    return seg / peak * 0.9


def spectrogram_png(seg: np.ndarray, sr: int, path: str, title: str) -> None:
    frames = np.lib.stride_tricks.sliding_window_view(seg, 512)[::128]
    win = np.hanning(512).astype(np.float32)
    S = np.abs(np.fft.rfft(frames * win, axis=1)).T
    S = np.log1p(S * 30)
    S = (S / (S.max() or 1) * 255).astype(np.uint8)
    img = Image.fromarray(S[::-1]).resize((360, 200), Image.NEAREST)
    canvas = Image.new("RGB", (360, 226), (4, 8, 9))
    canvas.paste(img.convert("RGB"), (0, 22))
    d = ImageDraw.Draw(canvas)
    d.text((4, 6), title, fill=(157, 246, 255))
    canvas.save(path)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    x, sr = read_wav(SRC)
    x = highpass(x, sr, 550.0)

    cand = find_onsets(x, sr)
    # privilegia banda larga e forza
    cand.sort(key=lambda c: (c["band"] * 0.65 + min(c["strength"], 8) / 8 * 0.35), reverse=True)
    print(f"candidati: {len(cand)}")
    for i, c in enumerate(cand[:14]):
        seg = cut(x, sr, c["t"])
        name = f"cand_{i:02d}_t{c['t']:.2f}_b{c['band']:.2f}.wav"
        write_wav(os.path.join(OUT, name), seg, sr)
        spectrogram_png(seg, sr, os.path.join(SHOTS, name.replace(".wav", ".png")),
                        f"{c['t']:.2f}s  band {c['band']:.2f}  str {c['strength']:.1f}")
        print(f"{i:02d}  t={c['t']:7.3f}  band={c['band']:.2f}  strength={c['strength']:5.2f}  {name}")


if __name__ == "__main__":
    main()
