"""Hook-title card: rounded banner with bold text, multiple visual themes, and iOS color emoji support."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config import get_settings

EMOJI_DIR_NAME = "emoji"

THEMES: dict[str, tuple[tuple[int, int, int, int], tuple[int, int, int, int], tuple[int, int, int, int] | None]] = {
    "light": ((255, 255, 255, 255), (15, 15, 18, 255), None),
    "dark": ((18, 18, 24, 240), (250, 250, 252, 255), (255, 255, 255, 42)),
    "accent": ((217, 70, 239, 245), (255, 255, 255, 255), (255, 255, 255, 65)),
    "glass": ((24, 24, 32, 185), (255, 255, 255, 255), (255, 255, 255, 80)),
}


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


def _emoji_img(tok: str, size: int) -> Image.Image | None:
    code = "-".join(f"{ord(c):x}" for c in tok if ord(c) != 0xFE0F)
    p = get_settings().assets_dir / EMOJI_DIR_NAME / f"{code}.png"
    if not p.exists():
        return None
    return Image.open(p).convert("RGBA").resize((size, size), Image.LANCZOS)


def _is_emoji_base(ch: str) -> bool:
    o = ord(ch)
    return o >= 0x1F000 or 0x2600 <= o <= 0x27BF or 0x2300 <= o <= 0x23FF


def _has_emoji(tok: str) -> bool:
    return any(_is_emoji_base(c) for c in tok)


def _tokens(text: str) -> list[str]:
    """Split into words while preserving multi-codepoint ZWJ emoji sequences intact."""
    out: list[str] = []
    for word in text.split():
        buf = ""
        i = 0
        n = len(word)
        while i < n:
            ch = word[i]
            if _is_emoji_base(ch):
                if buf:
                    out.append(buf)
                    buf = ""
                cluster = ch
                i += 1
                while i < n:
                    nxt = word[i]
                    o = ord(nxt)
                    if o == 0xFE0F or (0x1F3FB <= o <= 0x1F3FF):  # variation selector / skin tone
                        cluster += nxt
                        i += 1
                    elif o == 0x200D and i + 1 < n:  # ZWJ + next emoji glyph
                        cluster += nxt + word[i + 1]
                        i += 2
                    else:
                        break
                out.append(cluster)
                continue
            if ord(ch) in (0xFE0F, 0x200D):
                i += 1
                continue
            buf += ch
            i += 1
        if buf:
            out.append(buf)
    return out


def render_hook_card(
    text: str,
    dst: Path,
    *,
    out_w: int = 1080,
    font_size: int | None = None,
    max_width_ratio: float = 0.86,
    card_style: str = "light",
) -> tuple[Path, int, int]:
    """Returns (png_path, width, height)."""
    fs = font_size or max(32, int(round(54 * (out_w / 1080.0))))
    font = _font(fs)
    space = font.getlength(" ")
    emoji_size = int(fs * 1.05)
    pad_x = max(18, int(round(30 * (out_w / 1080.0))))
    pad_y = max(12, int(round(18 * (out_w / 1080.0))))
    radius = max(14, int(round(22 * (out_w / 1080.0))))
    max_w = int(out_w * max_width_ratio) - pad_x * 2
    toks = _tokens(text.strip()) or ["..."]

    def tok_w(t: str) -> float:
        return emoji_size if _has_emoji(t) else font.getlength(t)

    lines: list[list[str]] = [[]]
    cur = 0.0
    for t in toks:
        w = tok_w(t)
        if lines[-1] and cur + space + w > max_w:
            lines.append([])
            cur = 0.0
        cur += (space if lines[-1] else 0) + w
        lines[-1].append(t)

    line_h = int(fs * 1.22)
    widths = [sum(tok_w(t) for t in ln) + space * (len(ln) - 1) for ln in lines]
    box_w = min(int(out_w * 0.94), int(max(widths) + pad_x * 2))
    box_h = int(line_h * len(lines) + pad_y * 2)
    fill_col, text_col, border_col = THEMES.get(card_style, THEMES["light"])

    img = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, box_w - 1, box_h - 1), radius=radius, fill=fill_col, outline=border_col, width=2 if border_col else 0)
    ascent, _ = font.getmetrics()
    for i, (ln, lw) in enumerate(zip(lines, widths)):
        x = (box_w - lw) / 2
        y = pad_y + i * line_h
        for t in ln:
            if _has_emoji(t):
                em = _emoji_img(t, emoji_size)
                if em:
                    img.alpha_composite(em, (int(x), int(y + (line_h - emoji_size) / 2)))
                x += emoji_size + space
                continue
            d.text((x, y + (line_h - ascent) / 2 - 2), t, font=font, fill=text_col)
            x += font.getlength(t) + space
    img.save(dst)
    return dst, box_w, box_h
