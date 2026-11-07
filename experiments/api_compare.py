"""Confronto end-to-end via API: stessa zona, modalità AI vs TEXT."""
from __future__ import annotations

import base64
import json
import mimetypes
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8777"
SRC = Path("/Users/cypermac1/Pictures/prodest+ù.jpeg")
OUT = Path(__file__).resolve().parent / "shots" / "text_probe"
OUT.mkdir(parents=True, exist_ok=True)


def post_multipart(url: str, path: Path) -> dict:
    boundary = "----esperprobe"
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def save(data_url: str, name: str) -> Path:
    b64 = data_url.split(",", 1)[1]
    p = OUT / name
    p.write_bytes(base64.b64decode(b64))
    return p


def main() -> None:
    info = post_multipart(f"{BASE}/api/photo", SRC)
    pid = info["id"]
    print("photo id:", pid, info.get("w"), "x", info.get("h"))

    rect = {"x": 297, "y": 80, "w": 85, "h": 41, "out_w": 680}
    for mode, text in (("ai", False), ("text", True)):
        r = post_json(f"{BASE}/api/enhance", {"id": pid, **rect, "text": text})
        m = r["meta"]
        p = save(r["image"], f"api_{mode}.png")
        print(f"{mode:5s} → {p.name}  {m['out_w']}x{m['out_h']}  {m['passes']} pass  {m['ms']} ms  mode={m['mode']}")


if __name__ == "__main__":
    main()
