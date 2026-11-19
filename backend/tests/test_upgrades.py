"""Tests for all upgraded features: iOS emojis, captions/SRT/wrapping, reframing, render polish, security, and new APIs."""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlmodel import select

from app import queue
from app.config import get_settings
from app.db import init_db, session_scope
from app.main import app
from app.models import BrollClip, Clip, MusicTrack, Project, User
from app.pipeline import captions, highlights, hook_card, ingest, media, reframe, render, tasks
from app.presets import ASPECT_RATIOS, emoji_map, get_caption_style
from test_api import _signed_in

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


def test_ios_emojis_exist_and_safe_inflection_matching():
    emoji_dir = get_settings().assets_dir / "emoji"
    for kw, em in emoji_map().items():
        code = "-".join(f"{ord(c):x}" for c in em if ord(c) != 0xFE0F)
        png = emoji_dir / f"{code}.png"
        assert png.exists(), f"Missing iOS emoji PNG for '{kw}' -> {em} ({code}.png)"
        with Image.open(png) as im:
            assert im.mode == "RGBA" and im.width >= 64 and im.height >= 64

    assert captions.emoji_for("caring") == "🫶"
    assert captions.emoji_for("winning") == "🏆"
    assert captions.emoji_for("watershed") is None
    assert captions.emoji_for("starter") is None


def test_hook_card_zwj_clusters_and_themes(tmp_path):
    toks = hook_card._tokens("Family 👨‍👩‍👧 time 🔥")
    assert toks == ["Family", "👨‍👩‍👧", "time", "🔥"]
    for theme in ("light", "dark", "accent", "glass"):
        out, w, h = hook_card.render_hook_card("Wait for it 🔥 👨‍👩‍👧", tmp_path / f"{theme}.png", card_style=theme)
        assert out.exists() and w > 100 and h > 40


def test_captions_wrapping_boxed_auto_emoji_and_srt():
    words = [
        {"word": "Extraordinary", "start": 0.1, "end": 0.5},
        {"word": "entrepreneurship", "start": 0.55, "end": 1.0},
        {"word": "opportunities", "start": 1.05, "end": 1.5},
        {"word": "money", "start": 1.8, "end": 2.2},
    ]
    # Long words should insert explicit \N break inside libass \pos events
    netflix = get_caption_style("netflix_kinetic")
    ass, cues = captions.build_ass(words, netflix, out_w=1080, out_h=1920, caption_y=0.6, clip_duration=5.0, auto_emoji=True)
    assert "\\N" in ass
    assert cues and cues[0].png.name == "1f4b0.png"  # auto_emoji works on non-hormozi presets too

    boxed = get_caption_style("bold_boxed")
    ass_box, _ = captions.build_ass(words, boxed, out_w=1080, out_h=1920, caption_y=0.6, clip_duration=5.0)
    assert "BorderStyle" in ass_box and ",3," in ass_box

    srt = captions.build_srt(words)
    vtt = captions.build_vtt(words)
    assert "00:00:00,100 -->" in srt and "Extraordinary entrepreneurship" in srt
    assert vtt.startswith("WEBVTT") and "00:00:00.100 -->" in vtt


def test_silence_cuts_word_remap_and_filler_title():
    words = [
        {"word": "Hello", "start": 0.2, "end": 0.7},
        {"word": "there", "start": 0.75, "end": 1.1},
        {"word": "everyone.", "start": 1.15, "end": 1.5},
        # 2.0 second silence
        {"word": "Breaking", "start": 3.5, "end": 4.1},
        {"word": "big", "start": 4.15, "end": 4.55},
        {"word": "news!", "start": 4.6, "end": 5.0},
    ]
    segs = highlights.silence_cuts(words, 5.5)
    assert len(segs) == 2 and segs[0][1] < 1.8 and segs[1][0] > 3.2
    remapped = captions.remap_words_after_cuts(words, segs)
    assert remapped[-1]["end"] < 3.5
    assert highlights.make_title("Um, so basically this is the truth", "") == "This is the truth"


def test_scene_cut_camera_path_gaming_zoom_and_broll_layout():
    # Hard jump from x=0.2 to x=0.8 across a scene cut at t=2.0
    times = [i * 0.25 for i in range(16)]
    faces = [[(0.2, 0.4, 0.15, 0.2)]] * 8 + [[(0.8, 0.4, 0.15, 0.2)]] * 8
    tr = reframe.FaceTrack(times=times, faces=faces)
    _, cx_smooth, _ = reframe.camera_path(tr, smoothing=0.9, dead_zone=0.05)
    _, cx_cut, _ = reframe.camera_path(tr, smoothing=0.9, dead_zone=0.05, scene_cuts=[2.0])
    # With scene_cuts, index 8 immediately snaps to 0.8 instead of lagging behind near 0.25
    assert cx_cut[8] > 0.75 and cx_smooth[8] < 0.4

    # gaming_fast zoom fix
    g_lay = reframe.build_layout(
        "gameplay_facecam", src_w=1920, src_h=1080, out_w=1080, out_h=1920,
        track=tr, style={"zoom_on_emphasis": True, "zoom_amount": 1.12}, zoom_windows=[(1.0, 2.0)],
    )
    assert "overlay=0:0:enable='gt(between(t,1.00,2.00),0)'" in g_lay.filter

    # broll_split with & without B-roll
    b_lay = reframe.build_layout("broll_split", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=tr, style={}, has_broll=True)
    assert b_lay.layout_used == "broll_split" and "[broll:v]" in b_lay.filter and "vstack" in b_lay.filter
    fallback = reframe.build_layout("broll_split", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=tr, style={}, has_broll=False)
    assert fallback.layout_used == "face_track"

    assert "16:9" in ASPECT_RATIOS and ASPECT_RATIOS["16:9"] == (1920, 1080)


@needs_ffmpeg
def test_ffmpeg_render_with_polish_bar_watermark_and_silence_cuts(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=12:r=30",
                    "-f", "lavfi", "-i", "sine=f=330:d=12", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    work = tmp_path / "work"
    work.mkdir()
    hook_png, cw, ch = hook_card.render_hook_card("Test Hook 🔥", work / "hook.png", card_style="dark")
    words = [{"word": "Hello", "start": 0.2, "end": 0.8}, {"word": "world", "start": 1.0, "end": 2.0}]
    ass, cues = captions.build_ass(words, get_caption_style("bold_boxed"), out_w=1080, out_h=1920, caption_y=0.65, clip_duration=6.0)
    ass_path = captions.write_ass(work / "captions.ass", ass)
    spec = render.RenderSpec(
        source=src, start=0.0, end=10.0, out_path=work / "out.mp4", work_dir=work,
        video_filter="[0:v]crop=202:360:219:0,scale=1080:1920:flags=lanczos,setsar=1[vbase]",
        out_w=1080, out_h=1920, has_audio=True, ass_path=ass_path, emoji=cues, emoji_y=900,
        hook_png=hook_png, hook_xy=((1080 - cw) // 2, 120), hook_duration=3.0,
        keep_segments=[(0.0, 3.0), (5.0, 8.0)],
        normalize_audio=True, denoise_audio=True, progress_bar=True, watermark_text="@autoclip",
    )
    out = render.render(spec)
    info = media.probe(out)
    assert (info.width, info.height) == (1080, 1920)
    assert info.duration == pytest.approx(6.0, abs=0.4)


def test_ssrf_guard_user_isolation_and_new_clip_endpoints(tmp_path):
    init_db()
    with _signed_in(TestClient(app), "owner1@example.com") as alice:
        # SSRF blocks private/local URLs
        assert alice.post("/api/projects?start=false", json={"url": "http://127.0.0.1:8000/secret.mp4"}).status_code == 400
        assert alice.post("/api/projects?start=false", json={"url": "http://localhost/video.mp4"}).status_code == 400
        assert alice.post("/api/projects?start=false", json={"url": "http://169.254.169.254/latest"}).status_code == 400

        # Create project owned by Alice
        src = tmp_path / "source.mp4"
        src.write_bytes(b"\x00" * 4096)
        clip_vid = tmp_path / "clip.mp4"
        clip_vid.write_bytes(b"\x00" * 4096)
        with session_scope() as s:
            alice_u = s.exec(select(User).where(User.email == "owner1@example.com")).first()
            p = Project(user_id=alice_u.id, name="Alice Vid", source_type="path", source=str(src), source_path=str(src),
                        duration=60.0, status="done", settings={"aspect_ratio": "4:5"})
            s.add(p)
            s.commit()
            s.refresh(p)
            pdir = tasks.project_dir(p.id)
            (pdir / "transcript.json").write_text(json.dumps({"words": [
                {"word": "Hello", "start": 1.0, "end": 1.4},
                {"word": "world!", "start": 1.5, "end": 2.0},
            ]}))
            c = Clip(project_id=p.id, rank=1, start=1.0, end=20.0, status="ready", title="Original",
                     review_status="approved", posted={"tiktok": "2026-11-18T00:00:00Z"}, video_path=str(clip_vid))
            s.add(c)
            s.commit()
            s.refresh(c)
            pid, cid = p.id, c.id

        # Bob cannot access Alice's project
        with _signed_in(TestClient(app), "bob2@example.com") as bob:
            assert bob.get(f"/api/projects/{pid}").status_code == 404
            assert bob.patch(f"/api/clips/{cid}", json={"title": "Hacked"}).status_code == 404

        # Non-destructive restyle keeps clip edits/approvals/posted
        r = alice.post(f"/api/projects/{pid}/generate", json={"mode": "restyle", "settings": {"aspect_ratio": "1:1"}})
        assert r.status_code == 200
        with session_scope() as s:
            kept = s.get(Clip, cid)
            assert kept is not None and kept.review_status == "approved" and "tiktok" in kept.posted

        # Trim, words_override, per-clip overrides, SRT/VTT, bulk, storage & runtime settings
        r = alice.patch(f"/api/clips/{cid}", json={
            "start": 2.0, "end": 15.0,
            "words_override": [{"word": "Edited", "start": 0.2, "end": 0.6}],
            "overrides": {"caption_style": "bold_boxed", "aspect_ratio": "16:9"},
        })
        assert r.status_code == 200 and r.json()["duration"] == 13.0 and r.json()["has_words_override"] is True
        assert "Edited" in alice.get(f"/api/clips/{cid}/subtitles/srt").text
        assert "WEBVTT" in alice.get(f"/api/clips/{cid}/subtitles/vtt").text

        # Manual clip creation & transcript fetch
        assert len(alice.get(f"/api/projects/{pid}/transcript").json()["sentences"]) == 1
        mc = alice.post(f"/api/projects/{pid}/clips", json={"start": 0.5, "end": 10.0, "title": "Manual"})
        assert mc.status_code == 200 and mc.json()["title"] == "Manual"
        mc_id = mc.json()["id"]

        # Bulk reject & delete
        assert alice.post("/api/clips/bulk", json={"clip_ids": [mc_id], "action": "reject"}).json()["count"] == 1
        assert alice.post("/api/clips/bulk", json={"clip_ids": [mc_id], "action": "delete"}).json()["count"] == 1

        # Storage & runtime settings
        st = alice.get("/api/system/storage").json()
        assert st["disk"]["total"] > 0 and any(pr["id"] == pid for pr in st["projects"])
        cfg = alice.put("/api/settings", json={"default_watermark_text": "@mybrand"}).json()
        assert cfg["default_watermark_text"] == "@mybrand"

        # Prune source frees space
        with session_scope() as s:
            pr = s.get(Project, pid)
            pr.status = "done"
            s.add(pr)
            s.commit()
        pruned = alice.post(f"/api/projects/{pid}/prune-source").json()
        assert pruned["freed_bytes"] == 4096
