"""Hook-title card: white rounded box, bold black text, color emoji support.

This is the "stream clip" look (title on a white card above the video). Rendered once
per clip with Pillow to a transparent PNG and overlaid by FFmpeg.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config import get_settings

EMOJI_DIR_NAME = "emoji"


def _font(size: int) -> ImageFont.FreeTypeFont:
    fonts = get_settings().fonts_dir
    for name in ("Montserrat-800.ttf", "Poppins-700.ttf", "Montserrat-900.ttf"):
        p = fonts / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def _emoji_img(ch: str, size: int) -> Image.Image | None:
    code = "-".join(f"{ord(c):x}" for c in ch if ord(c) != 0xFE0F)
    p = get_settings().assets_dir / EMOJI_DIR_NAME / f"{code}.png"
    if not p.exists():
        return None
    return Image.open(p).convert("RGBA").resize((size, size), Image.LANCZOS)


def _is_emoji(ch: str) -> bool:
    o = ord(ch)
    return o >= 0x1F000 or 0x2600 <= o <= 0x27BF or 0x2300 <= o <= 0x23FF


def _tokens(text: str) -> list[str]:
    """Split into words; emoji become their own tokens."""
    out: list[str] = []
    for word in text.split():
        buf = ""
        for ch in word:
            if _is_emoji(ch):
                if buf:
                    out.append(buf)
                    buf = ""
                out.append(ch)
            elif ord(ch) in (0xFE0F, 0x200D):
                continue
            else:
                buf += ch
        if buf:
            out.append(buf)
    return out


def render_hook_card(text: str, dst: Path, *, out_w: int = 1080, font_size: int = 54, max_width_ratio: float = 0.86) -> tuple[Path, int, int]:
    """Returns (png_path, width, height)."""
    font = _font(font_size)
    space = font.getlength(" ")
    emoji_size = int(font_size * 1.05)
    max_w = int(out_w * max_width_ratio) - 60
    toks = _tokens(text.strip()) or ["..."]

    def tok_w(t: str) -> float:
        return emoji_size if len(t) == 1 and _is_emoji(t) else font.getlength(t)

    lines: list[list[str]] = [[]]
    cur = 0.0
    for t in toks:
        w = tok_w(t)
        if lines[-1] and cur + space + w > max_w:
            lines.append([])
            cur = 0.0
        cur += (space if lines[-1] else 0) + w
        lines[-1].append(t)

    line_h = int(font_size * 1.22)
    widths = [sum(tok_w(t) for t in ln) + space * (len(ln) - 1) for ln in lines]
    pad_x, pad_y = 30, 18
    box_w = int(max(widths) + pad_x * 2)
    box_h = int(line_h * len(lines) + pad_y * 2)
    img = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, box_w - 1, box_h - 1), radius=22, fill=(255, 255, 255, 255))
    ascent, _ = font.getmetrics()
    for i, (ln, lw) in enumerate(zip(lines, widths)):
        x = (box_w - lw) / 2
        y = pad_y + i * line_h
        for t in ln:
            if len(t) == 1 and _is_emoji(t):
                em = _emoji_img(t, emoji_size)
                if em:
                    img.alpha_composite(em, (int(x), int(y + (line_h - emoji_size) / 2)))
                x += emoji_size + space
                continue
            d.text((x, y + (line_h - ascent) / 2 - 2), t, font=font, fill=(0, 0, 0, 255))
            x += font.getlength(t) + space
    img.save(dst)
    return dst, box_w, box_h
