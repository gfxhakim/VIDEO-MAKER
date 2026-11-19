"""Trending FFmpeg visual effects applied after reframing and before captions/overlays."""
from __future__ import annotations


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def apply_video_effect(
    input_label: str,
    effect_key: str,
    out_w: int,
    out_h: int,
    out_label: str = "vefx",
) -> list[str]:
    """Return FFmpeg filtergraph fragments mapping `[input_label]` -> `[out_label]`.

    Returns an empty list when `effect_key` is `'none'`, empty, or unknown so callers
    leave `[input_label]` untouched.
    """
    key = (effect_key or "none").strip()
    if not key or key == "none":
        return []

    simple: dict[str, str] = {
        "hdr_punch": "eq=contrast=1.14:saturation=1.22:brightness=0.02,unsharp=5:5:0.85:5:5:0.0,vignette=PI/6",
        "hook_flash": "fade=t=in:st=0:d=0.08:color=white,eq=contrast=1.08:saturation=1.12,unsharp=5:5:0.45:5:5:0.0",
        "chromatic_glitch": "rgbashift=rh=8:bv=6:gh=-4:edge=smear:enable='between(t,0,0.45)+between(t,5.0,5.25)',eq=contrast=1.10:saturation=1.12",
        "blur_reveal": "gblur=sigma=16:enable='between(t,0,0.38)',eq=contrast=1.10:saturation=1.14",
        "dark_cinema": "colorbalance=rs=0.08:gs=0.01:bs=-0.10:rm=0.05:bm=-0.04,eq=contrast=1.16:brightness=-0.03:saturation=1.10,vignette=PI/3.5",
        "warm_film": "colorbalance=rs=0.05:gs=0.02:bs=-0.04,eq=contrast=1.10:gamma=1.04:saturation=1.06,noise=alls=8:allf=t,vignette=PI/4.5",
        "vhs_retro": "eq=contrast=1.06:saturation=0.90:brightness=0.02,chromashift=cbh=3:crh=-3:edge=smear,noise=alls=14:allf=t+u,vignette=PI/4",
        "noir_sigma": "hue=s=0,eq=contrast=1.28:brightness=-0.04,vignette=PI/3",
    }

    if key in simple:
        return [f"[{input_label}]{simple[key]}[{out_label}]"]

    if key == "dreamy_bloom":
        # Normalize pixel format before split/blend so both branches share identical yuv420p planes.
        return [
            f"[{input_label}]format=yuv420p,split=2[eb0][eb1];"
            f"[eb1]gblur=sigma=10,eq=brightness=0.05:saturation=1.25[ebg];"
            f"[eb0][ebg]blend=all_mode=screen:all_opacity=0.24,colorbalance=rs=0.07:gs=0.02:bs=-0.05,vignette=PI/5[{out_label}]"
        ]

    if key == "motion_shake":
        sw = max(out_w + 24, _even(out_w * 1.06))
        sh = max(out_h + 24, _even(out_h * 1.06))
        return [
            f"[{input_label}]scale={sw}:{sh}:flags=bilinear,"
            f"crop={out_w}:{out_h}:'(iw-{out_w})/2+if(lt(t,0.55),sin(t*48)*10*(1-t/0.55),0)':"
            f"'(ih-{out_h})/2+if(lt(t,0.55),cos(t*40)*8*(1-t/0.55),0)',"
            f"fade=t=in:st=0:d=0.07:color=white,eq=contrast=1.08:saturation=1.10,setsar=1[{out_label}]"
        ]

    return []
