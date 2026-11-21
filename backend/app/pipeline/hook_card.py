"""Hook-title card: floating rounded banner with gradient/theme styling, keyword color punch, soft shadow, and iOS color emoji support."""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..config import get_settings
from .highlights import EMOTION_WORDS

EMOJI_DIR_NAME = "emoji"

# theme -> (bg_start_rgba, bg_end_rgba, text_rgba, accent_rgba, border_rgba)
THEMES: dict[
    str,
    tuple[
        tuple[int, int, int, int],
        tuple[int, int, int, int],
        tuple[int, int, int, int],
        tuple[int, int, int, int],
        tuple[int, int, int, int] | None,
    ],
] = {
    "light": ((255, 255, 255, 252), (244, 244, 250, 252), (14, 14, 18, 255), (147, 51, 234, 255), (0, 0, 0, 26)),
    "dark": ((14, 15, 22, 246), (26, 24, 38, 246), (250, 250, 252, 255), (250, 204, 21, 255), (255, 255, 255, 52)),
    "accent": ((124, 58, 237, 250), (236, 72, 153, 250), (255, 255, 255, 255), (254, 240, 138, 255), (255, 255, 255, 78)),
    "glass": ((20, 22, 34, 198), (34, 32, 52, 198), (255, 255, 255, 255), (34, 211, 238, 255), (255, 255, 255, 92)),
    "viral_yellow": ((255, 230, 0, 255), (250, 204, 21, 255), (12, 12, 14, 255), (220, 38, 38, 255), (0, 0, 0, 35)),
    "breaking_red": ((225, 29, 72, 252), (153, 27, 27, 252), (255, 255, 255, 255), (254, 240, 138, 255), (255, 255, 255, 72)),
}

_HOOK_POWER_WORDS = EMOTION_WORDS | {
    "stop", "why", "secret", "secrets", "mistake", "mistakes", "truth", "never", "nobody",
    "reason", "rule", "rules", "hack", "hacks", "warning", "dead", "viral", "free", "fast",
}


def _font(size: int) -> ImageFont.FreeTypeFont:
    fonts = get_settings().fonts_dir
    for name in ("Montserrat-900.ttf", "Montserrat-800.ttf", "Poppins-700.ttf"):
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


def _is_accent_token(tok: str) -> bool:
    if "$" in tok or "%" in tok or any(ch.isdigit() for ch in tok):
        return True
    clean = re.sub(r"[^a-z]", "", tok.lower())
    return clean in _HOOK_POWER_WORDS


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
                    if o == 0xFE0F or (0x1F3FB <= o <= 0x1F3FF):
                        cluster += nxt
                        i += 1
                    elif o == 0x200D and i + 1 < n:
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


def _draw_rounded_card(
    w: int,
    h: int,
    radius: int,
    c0: tuple[int, int, int, int],
    c1: tuple[int, int, int, int],
    border_col: tuple[int, int, int, int] | None,
) -> Image.Image:
    """Create a rounded pill with optional smooth horizontal gradient fill and subtle highlight rim."""
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=255)
    if c0 == c1:
        fill = Image.new("RGBA", (w, h), c0)
    else:
        strip = Image.new("RGBA", (w, 1))
        px = [
            tuple(int(c0[k] + (c1[k] - c0[k]) * (x / max(1, w - 1))) for k in range(4))
            for x in range(w)
        ]
        strip.putdata(px)
        fill = strip.resize((w, h), Image.NEAREST)
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    card.paste(fill, (0, 0), mask)
    if border_col:
        bd = ImageDraw.Draw(card)
        bd.rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, outline=border_col, width=2)
    return card


def render_hook_card(
    text: str,
    dst: Path,
    *,
    out_w: int = 1080,
    font_size: int | None = None,
    max_width_ratio: float = 0.84,
    card_style: str = "light",
) -> tuple[Path, int, int]:
    """Returns (png_path, width, height) with soft shadow margins included."""
    fs = font_size or max(30, int(round(48 * (out_w / 1080.0))))
    font = _font(fs)
    space = font.getlength(" ")
    emoji_size = int(fs * 1.12)
    pad_x = max(20, int(round(32 * (out_w / 1080.0))))
    pad_y = max(14, int(round(20 * (out_w / 1080.0))))
    radius = max(16, int(round(24 * (out_w / 1080.0))))
    shadow_pad = max(12, int(round(18 * (out_w / 1080.0))))
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

    line_h = int(fs * 1.24)
    widths = [sum(tok_w(t) for t in ln) + space * (len(ln) - 1) for ln in lines]
    box_w = min(int(out_w * 0.92), int(max(widths) + pad_x * 2))
    box_h = int(line_h * len(lines) + pad_y * 2)

    c0, c1, text_col, accent_col, border_col = THEMES.get(card_style, THEMES["light"])

    # Soft drop shadow + gradient rounded card
    cw = box_w + shadow_pad * 2
    ch = box_h + shadow_pad * 2
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    dy = max(4, shadow_pad // 3)
    sd.rounded_rectangle(
        (shadow_pad, shadow_pad + dy, shadow_pad + box_w - 1, shadow_pad + box_h - 1 + dy),
        radius=radius,
        fill=(0, 0, 0, 145),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(5, shadow_pad // 2)))
    canvas.alpha_composite(shadow, (0, 0))

    card = _draw_rounded_card(box_w, box_h, radius, c0, c1, border_col)
    canvas.alpha_composite(card, (shadow_pad, shadow_pad))

    d = ImageDraw.Draw(canvas)
    ascent, _ = font.getmetrics()
    has_accent = any(_is_accent_token(t) for ln in lines for t in ln)
    accented = 0
    for i, (ln, lw) in enumerate(zip(lines, widths)):
        x = shadow_pad + (box_w - lw) / 2
        y = shadow_pad + pad_y + i * line_h
        for t in ln:
            if _has_emoji(t):
                em = _emoji_img(t, emoji_size)
                if em:
                    canvas.alpha_composite(em, (int(x), int(y + (line_h - emoji_size) / 2)))
                x += emoji_size + space
                continue
            use_accent = has_accent and _is_accent_token(t) and accented < 4
            if use_accent:
                accented += 1
            d.text((x, y + (line_h - ascent) / 2 - 2), t, font=font, fill=accent_col if use_accent else text_col)
            x += font.getlength(t) + space

    canvas.save(dst)
    return dst, cw, ch
