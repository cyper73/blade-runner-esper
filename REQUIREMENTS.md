# Requirements & Installation

Everything ESPER needs to run on a Mac. No Docker, no cloud account, no API key.

---

## 1. Host

| | Requirement |
|---|---|
| **Machine** | Apple Silicon Mac (M1 or newer). Tested on **M5 Pro, 24 GB, macOS 27.0.1** |
| **GPU backend** | Metal Performance Shaders (MPS). No CUDA, no ROCm |
| **Disk** | **~1.2 GB** — 500 MB virtualenv + 673 MB models (see §4) |
| **RAM** | 8 GB minimum. Tiled inference keeps peaks low; 16 GB+ recommended for large images |
| **Browser** | Chrome, Edge or Safari (Chromium preferred for full-screen and MediaRecorder) |

> Intel Macs are not supported: `torch==2.2.2` on macOS targets arm64, and MPS is
> the whole point of this build.

---

## 2. Python

**Python 3.9.x** — Apple's Command Line Tools interpreter (`/usr/bin/python3`,
tested 3.9.6). This is not a preference: `torch==2.2.2` for macOS arm64 is built
against 3.9, and newer interpreters break the wheel.

```bash
python3 --version          # expect 3.9.x
xcode-select --install     # if the interpreter is missing
```

---

## 3. Dependencies

### 3.1 Python packages (exact versions tested)

| Package | Version | Why pinned |
|---|---|---|
| `torch` | **2.2.2** | last macOS arm64 wheel with MPS support for Python 3.9 |
| `numpy` | **1.26.4** | **NumPy 2 breaks torch 2.2.2** (`Failed to initialize NumPy: _ARRAY_API not found`) |
| `pillow` | 11.3.0 | image I/O, EXIF, quantisation |
| `fastapi` | 0.128.8 | API |
| `uvicorn` | 0.39.0 | ASGI server |
| `python-multipart` | 0.0.20 | file uploads (photo, audio) |
| `pydantic` | 2.13.5 | request models (pulled by FastAPI) |

```bash
cd "blade runner photo analisys"
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install \
  "torch==2.2.2" \
  "numpy==1.26.4" \
  "pillow==11.3.0" \
  "fastapi==0.128.8" \
  "uvicorn==0.39.0" \
  "python-multipart==0.0.20"
```

Do **not** install the `realesrgan` or `basicsr` packages: they drag in a
torchvision that conflicts with this setup. `esper_engine.py` reimplements
RRDBNet in ~100 lines and loads the weights directly.

### 3.2 System tools (Homebrew)

| Tool | Version tested | Used for |
|---|---|---|
| `ffmpeg` | 9.0.1 | decoding recorded audio to 16 kHz mono WAV |
| `whisper-cpp` | **1.9.5** (provides `whisper-cli`) | local speech recognition |

```bash
brew install ffmpeg whisper-cpp
```

`whisper-cpp` also pulls `ggml`, `llama.cpp` and may upgrade `openssl@4` — that is
normal. It does **not** ship any model: see §4.

Check:

```bash
ffmpeg -version | head -1
whisper-cli --help | head -3
```

---

## 4. Model weights (not bundled)

| File | Size | Source | Required |
|---|---|---|---|
| `models/4x_foolhardy_Remacri.pth` | 64 MB | [HF `uwg/upscaler`](https://huggingface.co/uwg/upscaler) | **yes** — default upscaler |
| `models/whisper/ggml-small.bin` | 465 MB | [HF `ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp) | **yes** for voice |
| `models/RealESRGAN_x4plus.pth` | 64 MB | [Real-ESRGAN releases](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0) | fallback |
| `models/4x-UltraSharp.pth` | 64 MB | HF `uwg/upscaler` | optional |

```bash
mkdir -p models/whisper

# default upscaler
curl -L -o models/4x_foolhardy_Remacri.pth \
  https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x_foolhardy_Remacri.pth

# fallback upscaler
curl -L -o models/RealESRGAN_x4plus.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth

# local speech recognition
curl -L -o models/whisper/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

All three can be downloaded from a browser instead — only the file names and
locations matter.

---

## 5. Permissions

| Permission | When | Where |
|---|---|---|
| **Microphone** | first time you press `MIC` | browser prompt → System Settings → Privacy & Security → Microphone |
| **Full screen** | first `⛶` click | browser handles it; it must be a real user gesture |

No other permission is needed. The server listens on `127.0.0.1` only.

---

## 6. Environment variables (optional)

| Variable | Default | Effect |
|---|---|---|
| `ESPER_MODEL` | `models/4x_foolhardy_Remacri.pth` | override the upscaler |
| `WHISPER_MODEL` | `models/whisper/ggml-small.bin` | use `ggml-medium.bin` for more accuracy |
| `WHISPER_BIN` | auto (`whisper-cli` on PATH) | explicit path to the binary |

Example:

```bash
WHISPER_MODEL="$PWD/models/whisper/ggml-medium.bin" ./start.command
```

---

## 7. Verify the installation

```bash
./start.command
```

Then:

```bash
curl -s http://127.0.0.1:8777/api/status | python3 -m json.tool
```

Expected — both `ok` and `whisper` must be `true`:

```json
{
  "ok": true,
  "mode": "realesrgan-x4",
  "device": "mps",
  "model_path": ".../models/4x_foolhardy_Remacri.pth",
  "torch": "2.2.2",
  "error": null,
  "whisper": true,
  "whisper_model": "ggml-small.bin"
}
```

Voice check without a microphone (uses macOS `say`):

```bash
say -v Alice -o /tmp/v.aiff "avvicina"
curl -s -F "audio=@/tmp/v.aiff" "http://127.0.0.1:8777/api/voice?lang=it"
# → {"text":"avvicina","ms":478,"model":"ggml-small.bin"}   (ms varies: 300–500)
```

Upscaler check:

```bash
curl -s -F "file=@static/assets/prodest.jpg" http://127.0.0.1:8777/api/photo
# → {"id":"…","w":…,"h":…,"exif":{…}}
```

---

## 8. Optional upgrades

- **More accurate voice**: download `ggml-medium.bin` (~1.5 GB) from the same
  repository and point `WHISPER_MODEL` at it. Roughly 3× slower on M5.
- **Different look**: `4x-UltraSharp` is sharper but rings on edges; `x4plus` is
  softer and misreads characters. Remacri is the balance.
- **Larger images**: raise `MAX_OUT` / `MAX_SIDE` in `server.py` at the cost of
  memory and time.

---

## 9. Troubleshooting installation

| Error | Fix |
|---|---|
| `mach-o file, but is an incompatible architecture` | wrong wheel: recreate the venv with the arm64 Python 3.9 |
| `Failed to initialize NumPy: _ARRAY_API not found` | `pip install "numpy==1.26.4"` |
| `ModuleNotFoundError: No module named 'multipart'` | `pip install python-multipart` |
| `whisper-cli: command not found` | `brew install whisper-cpp`, or set `WHISPER_BIN` |
| `/api/voice` → `503 whisper.cpp non disponibile` | binary or `ggml-small.bin` missing |
| `OSError: [Errno 48] Address already in use` | `pkill -f "server.py"` |
| MPS not used (`device: "cpu"`) | Python built without Metal support: use the system 3.9 interpreter |

---

## 10. Other platforms (Linux / Windows)

`esper_engine.py` already selects **`mps → cuda → cpu`**; `ESPER_DEVICE` forces
the choice (`cpu`, `cuda`, `mps`). What changes is the packaging, not the code.

### Linux

```bash
sudo apt install ffmpeg python3-venv          # Debian/Ubuntu
python3 -m venv .venv
./.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121  # NVIDIA
./.venv/bin/pip install numpy==1.26.4 pillow fastapi "uvicorn[standard]" python-multipart

# whisper.cpp: build from source (no model download in the package)
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
# binary: build/bin/whisper-cli  → put it on PATH or set WHISPER_BIN

./start.sh
```

Notes: Python **3.10–3.12** is fine here — the `3.9` pin is a macOS/torch-wheel
constraint. Without an NVIDIA GPU, install the plain CPU wheel and set
`ESPER_DEVICE=cpu`.

### Windows

```bat
python -m venv .venv
.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu121
.venv\Scripts\pip install numpy==1.26.4 pillow fastapi "uvicorn[standard]" python-multipart
```

- **ffmpeg**: `winget install Gyan.FFmpeg`, or place `ffmpeg.exe` on `PATH`; if you
  prefer not to touch `PATH`, set `FFMPEG_BIN=C:\tools\ffmpeg\bin\ffmpeg.exe`.
- **whisper.cpp**: grab a prebuilt release from
  `github.com/ggml-org/whisper.cpp/releases` (`whisper-cli.exe`), or build with
  CMake. Set `WHISPER_BIN` if it is not on `PATH`.
- Launcher: **`start.bat`**. `pkill` and `say` do not exist; the batch simply
  starts a second server window (close it to stop).

### Performance expectations

| Backend | 85×41 → 340×164 | 520×390 → 2080×1560 |
|---|---|---|
| MPS (M5 Pro) | 141 ms | ~2.5 s |
| CUDA (mid-range NVIDIA) | ~150–400 ms | ~3–6 s |
| CPU (desktop x86) | ~0.8–4 s | ~30–90 s |

CPU-only works but is not interactive for large crops. Keep the crop small.

### What is *not* verified

The Linux and Windows paths have not been run on real hardware. The CPU branch
**has** been exercised on macOS (`ESPER_DEVICE=cpu`: 315 ms, identical output),
which is the same code path a CPU-only Linux box would take. Everything else —
paths, ffmpeg and whisper discovery — is standard `shutil.which`, but treat the
first run on a new OS as a test, not a guarantee.

---
