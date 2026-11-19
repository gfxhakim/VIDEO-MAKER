"""Extract latest Apple iOS emoji PNGs for every emoji in presets/emoji_map.json (plus extra UI/hook emojis).

Downloads AppleColorEmoji-Linux.ttf (from samuelngs/apple-emoji-ttf, macOS/iOS 26 release)
and emoji-datasource-apple (for any multi-codepoint ZWJ fallbacks) into a temp directory,
then writes crisp 96x96 RGBA PNGs into backend/assets/emoji/<codepoints>.png.

Requires: fonttools, pillow (only needed when running this refresh script).
"""
from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
EMOJI_DIR = ROOT / "assets" / "emoji"
EMOJI_MAP = ROOT / "app" / "presets" / "emoji_map.json"

APPLE_TTF_URL = (
    "https://github.com/samuelngs/apple-emoji-ttf/releases/download/"
    "macos-26-20260722-484daf4e/AppleColorEmoji-Linux.ttf"
)
APPLE_DATASOURCE_TGZ = "https://registry.npmjs.org/emoji-datasource-apple/-/emoji-datasource-apple-16.0.0.tgz"

EXTRA_EMOJIS = [
    "🙌", "👍", "👎", "👌", "👉", "👇", "⬆️", "⬇️", "💬", "📢", "🎙️", "🎬", "📸", "🎧",
    "💎", "🪙", "🫧", "🫡", "🥹", "🫠", "🫣", "🫨", "🫶", "🫩", "❤️‍🔥", "🐦‍🔥",
]


def emoji_code(emoji: str) -> str:
    return "-".join(f"{ord(c):x}" for c in emoji if ord(c) != 0xFE0F)


def all_target_emojis() -> dict[str, str]:
    data = json.loads(EMOJI_MAP.read_text(encoding="utf-8"))
    data.pop("_doc", None)
    targets: dict[str, str] = {}
    for e in list(data.values()) + EXTRA_EMOJIS:
        targets[emoji_code(e)] = e
    return targets


def _resolve_glyph(code: str, cmap: dict[int, str], strike: dict) -> str | None:
    parts = [int(x, 16) for x in code.split("-")]
    if len(parts) == 1:
        g = cmap.get(parts[0])
        if g and g in strike:
            return g
        if g and f"{g}.0" in strike:
            return f"{g}.0"
        return None
    # ZWJ / sequence: try Apple's uXXXX_uYYYY glyph naming
    no_zwj = [p for p in parts if p != 0x200D]
    joined = "_".join(f"u{p:X}" for p in no_zwj)
    for cand in (joined, f"{joined}.0"):
        if cand in strike:
            return cand
    return None


def main() -> int:
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        print("Install fonttools to run this script: pip install fonttools", file=sys.stderr)
        return 1

    EMOJI_DIR.mkdir(parents=True, exist_ok=True)
    targets = all_target_emojis()
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        ttf_path = tmp / "AppleColorEmoji.ttf"
        print("Downloading latest Apple Color Emoji font...")
        urllib.request.urlretrieve(APPLE_TTF_URL, ttf_path)
        font = TTFont(ttf_path)
        cmap = font.getBestCmap()
        strike = font["CBDT"].strikeData[-1]  # highest strike (96x96 full RGBA)

        # Remove old PNGs so no stale Twemoji assets remain
        for old in EMOJI_DIR.glob("*.png"):
            old.unlink()

        missing: list[str] = []
        extracted = 0
        for code in sorted(targets):
            g = _resolve_glyph(code, cmap, strike)
            if g and g in strike:
                img = Image.open(io.BytesIO(strike[g].imageData)).convert("RGBA")
                img.save(EMOJI_DIR / f"{code}.png", optimize=True)
                extracted += 1
            else:
                missing.append(code)

        if missing:
            tgz_path = tmp / "apple-datasource.tgz"
            print(f"Downloading emoji-datasource-apple fallback for {len(missing)} ZWJ sequence(s)...")
            urllib.request.urlretrieve(APPLE_DATASOURCE_TGZ, tgz_path)
            with tarfile.open(tgz_path, "r:gz") as tf:
                names = {Path(m.name).name: m for m in tf.getmembers() if "/img/apple/64/" in m.name and m.name.endswith(".png")}
                for code in list(missing):
                    cand_names = [f"{code}.png", f"{code.replace('-200d-', '-fe0f-200d-')}.png"]
                    hit = next((names[n] for n in cand_names if n in names), None)
                    if hit:
                        raw = tf.extractfile(hit).read()  # type: ignore[union-attr]
                        img = Image.open(io.BytesIO(raw)).convert("RGBA").resize((96, 96), Image.LANCZOS)
                        img.save(EMOJI_DIR / f"{code}.png", optimize=True)
                        missing.remove(code)
                        extracted += 1

    print(f"Saved {extracted} iOS emoji PNGs to {EMOJI_DIR}")
    if missing:
        print(f"Warning: {len(missing)} still missing: {missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
