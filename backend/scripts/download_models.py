"""Download OpenCV's lightweight YuNet ONNX face detection model (~228 KB).

Run once:  python scripts/download_models.py
Saved into backend/assets/models/ (or DATA_DIR/models/) so reframe.py uses YuNet
with automatic fallback to Haar cascades when offline.
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "assets" / "models"
YUNET_FILENAME = "face_detection_yunet_2023mar.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dest = MODELS_DIR / YUNET_FILENAME
    if dest.exists() and dest.stat().st_size > 100_000:
        print(f"  exists  {dest}")
        return 0
    tmp = dest.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(YUNET_URL, tmp)
        tmp.replace(dest)
        print(f"  saved   {dest} ({dest.stat().st_size // 1024} KB)")
        return 0
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
