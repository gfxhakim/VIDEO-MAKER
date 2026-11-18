"""Download the open-source (OFL) fonts used by the caption presets.

Run once:  python scripts/download_fonts.py
Fonts land in backend/fonts/ which FFmpeg/libass and Pillow read from.
Add your own .ttf/.otf files to that folder and reference them by family name
in app/presets/caption_styles.json.
"""
from __future__ import annotations

import re
import sys
import urllib.request
from pathlib import Path

FONTS_DIR = Path(__file__).resolve().parent.parent / "fonts"

# Google Fonts CSS2 query. An old User-Agent makes Google return plain .ttf URLs.
FAMILIES = [
    "Montserrat:ital,wght@0,600;0,800;0,900;1,800;1,900",
    "Anton",
    "Bebas+Neue",
    "DM+Serif+Display",
    "Poppins:wght@600;700;800",
    "Noto+Color+Emoji",
]
UA = "Mozilla/4.0"


def main() -> int:
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    url = "https://fonts.googleapis.com/css2?" + "&".join(f"family={f}" for f in FAMILIES)
    css = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA})).read().decode()
    blocks = re.findall(r"@font-face\s*{(.*?)}", css, re.S)
    for block in blocks:
        family = re.search(r"font-family:\s*'([^']+)'", block).group(1)
        style = re.search(r"font-style:\s*(\w+)", block).group(1)
        weight = re.search(r"font-weight:\s*(\d+)", block).group(1)
        src = re.search(r"url\((https://[^)]+)\)", block).group(1)
        ext = src.rsplit(".", 1)[-1]
        name = f"{family.replace(' ', '')}-{weight}{'Italic' if style == 'italic' else ''}.{ext}"
        dest = FONTS_DIR / name
        if dest.exists():
            print(f"  exists  {name}")
            continue
        data = urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": UA})).read()
        dest.write_bytes(data)
        print(f"  saved   {name} ({len(data) // 1024} KB)")
    print(f"Fonts ready in {FONTS_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
