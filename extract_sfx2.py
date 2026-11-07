"""
Seconda passata: cerca i suoni MORBIDI della scena.

- ronzio: la finestra più stazionaria (poca voce, poca dinamica) → loop ambientale
- fruscio: eventi a inviluppo lento (150–600 ms), non click → carta/manipolazione
- guasto: il click più grave, da rallentare

    python extract_sfx2.py
"""
from __future__ import annotations

import os
import wave

import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import butter, sosfilt

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "audio_raw", "scene.wav")
OUT = os.path.join(ROOT, "audio_raw", "candidates2")
SHOTS = os.path.join(ROOT, "shots", "sfx2")
SR = 44100
T0, T1 = 52.0, 118.0


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


def band(x: np.ndarray, lo: float, hi: float, sr: int) -> np.ndarray:
    sos = butter(4, [lo, hi], btype="bandpass", fs=sr, output="sos")
    return sosfilt(sos, x).astype(np.float32)


def env(x: np.ndarray, sr: int, ms=10):
    w = max(1, int(ms * 0.001 * sr))
    return np.convolve(np.abs(x), np.ones(w) / w, mode="same")


def find_hum(x: np.ndarray, sr: int, win_s=6.0, step=0.5, n=3):
    """Finestre piu' stazionarie: poca voce, poca dinamica."""
    voice = band(x, 250, 3200, sr)
    ev = env(voice, sr, 20)
    w = int(win_s * sr)
    st = int(step * sr)
    scores = []
    for a in range(int(T0 * sr), min(len(x) - w, int(T1 * sr)), st):
        seg = ev[a:a + w]
        # stazionarieta' spettrale + bassa energia vocale
        mean = float(seg.mean())
        std = float(seg.std())
        peaks = float(np.percentile(seg, 99) - np.percentile(seg, 50))
        score = mean + std * 2.0 + peaks * 3.0
        scores.append((score, a))
    scores.sort()
    return [(a / sr, s) for s, a in scores[:n]]


def find_soft(x: np.ndarray, sr: int, n=10):
    """Eventi a inviluppo lento: fruscii, stoffa, carta."""
    hf = band(x, 1200, 9000, sr)
    e = env(hf, sr, 12)
    thr = float(np.percentile(e, 82))
    above = e > thr
    events = []
    i = 0
    while i < len(above):
        if above[i]:
            j = i
            while j < len(above) and above[j]:
                j += 1
            dur = (j - i) / sr
            if 0.12 <= dur <= 0.75:
                seg = e[i:j]
                # attack: tempo per arrivare all'80% del massimo
                ipk = int(np.argmax(seg))
                attack = ipk / sr
                if attack > 0.012:
                    tmid = ((i + j) / 2) / sr
                    if T0 <= tmid <= T1:
                        events.append({
                            "t": tmid,
                            "dur": dur,
                            "attack": attack,
                            "peak": float(seg.max()),
                        })
            i = j
        else:
            i += 1
    events.sort(key=lambda e: e["peak"] * (1.0 if e["attack"] > 0.02 else 0.5), reverse=True)
    return events[:n]


def spectrogram(seg: np.ndarray, sr: int, path: str, title: str):
    frames = np.lib.stride_tricks.sliding_window_view(seg, 512)[::128]
    S = np.abs(np.fft.rfft(frames * np.hanning(512), axis=1)).T
    S = np.log1p(S * 40)
    S = (S / (S.max() or 1) * 255).astype(np.uint8)
    img = Image.fromarray(S[::-1]).resize((320, 170), Image.NEAREST).convert("RGB")
    cv = Image.new("RGB", (320, 192), (4, 8, 9))
    cv.paste(img, (0, 22))
    ImageDraw.Draw(cv).text((4, 6), title, fill=(157, 246, 255))
    cv.save(path)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    x, sr = read_wav(SRC)

    # ── ronzio ──────────────────────────────────────────────────────────
    print("== finestre piu' stazionarie (possibile ronzio) ==")
    for i, (t, sc) in enumerate(find_hum(x, sr)):
        a = int(t * sr)
        seg = x[a:a + int(6.0 * sr)].copy()
        write_wav(os.path.join(OUT, f"hum_{i}_t{t:06.2f}.wav"), seg, sr)
        spectrogram(seg, sr, os.path.join(SHOTS, f"hum_{i}.png"),
                    f"HUM {i}  t={t:.1f}s  score={sc:.4f}")
        print(f"  hum_{i}  t={t:7.2f}s  score={sc:.4f}")

    # ── fruscii ─────────────────────────────────────────────────────────
    print("== eventi morbidi (possibile fruscio) ==")
    soft = find_soft(x, sr)
    for i, ev in enumerate(soft):
        a = max(0, int((ev["t"] - ev["dur"] / 2 - 0.12) * sr))
        b = min(len(x), int((ev["t"] + ev["dur"] / 2 + 0.25) * sr))
        seg = x[a:b].copy()
        p = np.max(np.abs(seg)) or 1.0
        seg = seg / p * 0.9
        name = f"soft_{i:02d}_t{ev['t']:06.2f}.wav"
        write_wav(os.path.join(OUT, name), seg, sr)
        spectrogram(seg, sr, os.path.join(SHOTS, name.replace(".wav", ".png")),
                    f"SOFT {i}  t={ev['t']:.1f}s  dur={ev['dur']*1000:.0f}ms  att={ev['attack']*1000:.0f}ms")
        print(f"  soft_{i:02d}  t={ev['t']:7.2f}s  dur={ev['dur']*1000:5.0f}ms  "
              f"attack={ev['attack']*1000:4.0f}ms  {name}")


if __name__ == "__main__":
    main()
