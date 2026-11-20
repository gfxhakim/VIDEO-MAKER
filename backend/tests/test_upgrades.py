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


def test_viral_scoring_and_clean_speech_end_boundaries():
    # Segment A (0..18s): strong contrarian hook + numbers + emotion + complete ending + 0.6s pause
    # Segment B (18.6..36.6s): weak rambling filler ending mid-clause with trailing chatter
    words_a = [
        ("Stop", 0.5, 0.8), ("doing", 0.85, 1.15), ("this", 1.2, 1.45), ("biggest", 1.5, 1.9),
        ("mistake!", 1.95, 2.4), ("Nobody", 2.7, 3.05), ("tells", 3.1, 3.4), ("you", 3.45, 3.65),
        ("how", 3.7, 3.95), ("$10,000", 4.0, 4.6), ("changed", 4.65, 5.1), ("my", 5.15, 5.35),
        ("entire", 5.4, 5.8), ("life", 5.85, 6.2), ("forever.", 6.25, 6.8),
        ("Here's", 7.1, 7.5), ("the", 7.55, 7.75), ("unbelievable", 7.8, 8.4), ("truth", 8.45, 8.85),
        ("everyone", 8.9, 9.35), ("missed!", 9.4, 9.9), ("It", 10.2, 10.4), ("was", 10.45, 10.7),
        ("literally", 10.75, 11.2), ("insane!", 11.25, 11.9),
    ]
    words_b = [
        ("And", 13.0, 13.2), ("then", 13.25, 13.5), ("basically", 13.55, 14.0), ("we", 14.05, 14.2),
        ("kind", 14.25, 14.5), ("of", 14.55, 14.7), ("went", 14.75, 15.05), ("over", 15.1, 15.4),
        ("stuff", 15.45, 15.8), ("like", 15.85, 16.1), ("that", 16.15, 16.45), ("you", 16.5, 16.7),
        ("know", 16.75, 17.0), ("what", 17.05, 17.3), ("I", 17.35, 17.5), ("mean", 17.55, 17.85),
        ("or", 17.9, 18.1), ("whatever", 18.15, 18.6), ("anyway", 18.65, 19.0), ("so", 19.05, 19.3),
        ("yeah", 19.35, 19.7), ("things", 19.75, 20.1), ("happen", 20.15, 20.6), ("sometimes", 20.65, 21.3),
        ("really", 21.35, 21.8), ("often", 21.85, 22.3), ("maybe", 22.35, 22.9), ("okay", 22.95, 23.4),
    ]
    words = [{"word": w, "start": a, "end": b} for w, a, b in (words_a + words_b)]
    dur = 25.0
    energy = np.full(int(dur / 0.25) + 2, -28.0, dtype=np.float32)
    energy[1:48] = -14.0  # energetic delivery during viral section A
    energy[48:50] = -42.0  # clear pause after "insane!"

    chosen = highlights.select_highlights(
        duration=dur, words=words, energy_db=energy, energy_step=0.25,
        scene_cuts=[1.0, 4.0], count=2, min_len=9.0, max_len=14.0,
    )
    assert len(chosen) >= 1
    top = chosen[0]
    assert top.start < 5.0 and 12.0 <= top.end <= 12.95  # inside viral section A, ends cleanly on "insane!" before "And" (13.0)
    assert top.ends_clean is True
    if len(chosen) > 1:
        assert chosen[0].score > chosen[1].score + 10.0

    # Manual snap_range_to_speech snaps mid-sentence end (9.5s) cleanly to "missed!" sentence boundary
    s_snap, e_snap = highlights.snap_range_to_speech(words, 0.5, 9.5, dur)
    assert s_snap < 0.6 and 9.9 <= e_snap <= 10.18


@needs_ffmpeg
def test_video_effects_and_playback_speed_render(tmp_path):
    from app.presets import video_effects

    fx_map = video_effects()
    assert {"none", "hdr_punch", "hook_flash", "chromatic_glitch", "blur_reveal", "motion_shake",
            "dark_cinema", "dreamy_bloom", "warm_film", "vhs_retro", "noir_sigma"} <= set(fx_map)

    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=8:r=30",
                    "-f", "lavfi", "-i", "sine=f=330:d=8", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    for fx_key in ("chromatic_glitch", "dreamy_bloom", "motion_shake"):
        work = tmp_path / fx_key
        work.mkdir()
        spec = render.RenderSpec(
            source=src, start=0.0, end=6.0, out_path=work / "clip.mp4", work_dir=work,
            video_filter="[0:v]crop=202:360:219:0,scale=360:640:flags=lanczos,setsar=1[vbase]",
            out_w=360, out_h=640, has_audio=True, video_effect=fx_key, speed=1.25,
        )
        out = render.render(spec)
        info = media.probe(out)
        assert (info.width, info.height) == (360, 640)
        assert info.duration == pytest.approx(6.0 / 1.25, abs=0.35)
        assert info.has_audio is True


def test_post_gen_overrides_reset_batch_apply_and_presets_api(tmp_path):
    init_db()
    with _signed_in(TestClient(app), "fxuser@example.com") as c:
        presets = c.get("/api/presets").json()
        assert any(fx["key"] == "hdr_punch" for fx in presets["video_effects"])
        assert len(presets["playback_speeds"]) >= 4

        # Invalid video_effect rejected
        assert c.post("/api/projects?start=false", json={"url": "https://e.com/v", "settings": {"video_effect": "bogus_fx"}}).status_code == 400

        src = tmp_path / "src.mp4"
        src.write_bytes(b"\x00" * 1024)
        song = tmp_path / "track.mp3"
        song.write_bytes(b"\x00" * 512)
        with session_scope() as s:
            u = s.exec(select(User).where(User.email == "fxuser@example.com")).first()
            p = Project(user_id=u.id, name="FX", source_type="path", source=str(src), source_path=str(src),
                        duration=40.0, status="done", settings={"video_effect": "none", "playback_speed": 1.0})
            mt = MusicTrack(user_id=u.id, name="Hype Beat", path=str(song), analyzed=True)
            s.add(p)
            s.add(mt)
            s.commit()
            s.refresh(p)
            s.refresh(mt)
            c1 = Clip(project_id=p.id, rank=1, start=1.0, end=12.0, status="ready")
            c2 = Clip(project_id=p.id, rank=2, start=14.0, end=25.0, status="ready")
            s.add(c1)
            s.add(c2)
            s.commit()
            s.refresh(c1)
            s.refresh(c2)
            pid, mid, id1, id2 = p.id, mt.id, c1.id, c2.id

        # Per-clip override then clear via None
        r = c.patch(f"/api/clips/{id1}", json={
            "music_track_id": mid,
            "overrides": {"video_effect": "dark_cinema", "playback_speed": 1.15, "music_volume": 0.25},
        })
        assert r.status_code == 200
        assert r.json()["music_track_id"] == mid
        assert r.json()["overrides"]["video_effect"] == "dark_cinema"

        r2 = c.patch(f"/api/clips/{id1}", json={"overrides": {"video_effect": None}})
        assert r2.status_code == 200
        assert "video_effect" not in r2.json()["overrides"]
        assert r2.json()["overrides"]["playback_speed"] == 1.15

        # Batch apply FX + speed + music + re-render
        rb = c.post("/api/clips/bulk", json={
            "clip_ids": [id1, id2],
            "action": "apply",
            "music_track_id": mid,
            "overrides": {"video_effect": "hdr_punch", "playback_speed": 1.1},
            "rerender": True,
        })
        assert rb.status_code == 200 and rb.json()["count"] == 2
        with session_scope() as s:
            for cid in (id1, id2):
                cl = s.get(Clip, cid)
                assert cl.music_track_id == mid
                assert cl.overrides["video_effect"] == "hdr_punch"
                assert cl.overrides["playback_speed"] == 1.1
                assert cl.status == "pending"

        # Cleanup manual clip with snap_speech
        (tasks.project_dir(pid) / "transcript.json").write_text(json.dumps({
            "words": [
                {"word": "First", "start": 2.0, "end": 2.4},
                {"word": "line.", "start": 2.45, "end": 3.0},
                {"word": "Second", "start": 3.6, "end": 4.0},
                {"word": "finish!", "start": 4.05, "end": 4.5},
            ]
        }))
        mc = c.post(f"/api/projects/{pid}/clips", json={"start": 2.0, "end": 4.3, "snap_speech": True})
        assert mc.status_code == 200 and mc.json()["end"] >= 4.5


def test_admin_panel_activity_tracking_and_bootstrap(tmp_path, monkeypatch):
    from app.api import auth as auth_api
    from app.auth import hash_password
    from app.models import ActivityLog

    init_db()

    # 1. Existing DB upgrade path: if zero admins exist, earliest user gets promoted to admin
    with session_scope() as s:
        prev_roles = [(row.id, row.role) for row in s.exec(select(User)).all()]
        for row in s.exec(select(User)).all():
            row.role = "user"
            s.add(row)
        legacy = User(email="legacyowner@example.com", name="Legacy Owner", password_hash=hash_password("pass1234"), role="user")
        s.add(legacy)
        s.commit()
        earliest = s.exec(select(User).order_by(User.id)).first()
        earliest_id = earliest.id
    try:
        auth_api.bootstrap_admin()
        with session_scope() as s:
            u = s.get(User, earliest_id)
            assert u is not None and u.role == "admin"
    finally:
        with session_scope() as s:
            for uid_, role_ in prev_roles:
                row = s.get(User, uid_)
                if row:
                    row.role = role_
                    s.add(row)
            s.commit()

    # 2. ADMIN_EMAIL / ADMIN_PASSWORD bootstrap creates/syncs exact admin credentials
    monkeypatch.setenv("ADMIN_EMAIL", "BossAdmin@Example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "RailWayPass99")
    get_settings.cache_clear()
    try:
        auth_api.bootstrap_admin()
    finally:
        monkeypatch.delenv("ADMIN_EMAIL", raising=False)
        monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
        get_settings.cache_clear()

    with session_scope() as s:
        boss = s.exec(select(User).where(User.email == "bossadmin@example.com")).first()
        assert boss is not None and boss.role == "admin" and boss.is_active is True

    # 3. Visitor self-registers via public signup, creates a project, admin tracks everything
    visitor_client = TestClient(app)
    with visitor_client as v:
        st = v.get("/api/auth/status").json()
        assert st["signup_open"] is True
        rv = v.post("/api/auth/signup", json={"email": "newvisitor@example.com", "password": "visitorpass", "name": "Visitor"})
        assert rv.status_code == 200 and rv.json()["role"] == "user"
        vid = rv.json()["id"]

        # Standard user is blocked from admin routes
        assert v.get("/api/admin/overview").status_code == 403
        assert v.get("/api/admin/users").status_code == 403
        assert v.get("/api/admin/activity").status_code == 403

        # Visitor performs tracked actions
        rp = v.post("/api/projects?start=false", json={"url": "https://example.com/demo.mp4", "name": "Visitor Podcast"})
        assert rp.status_code == 200
        v_pid = rp.json()["id"]
        assert v.put("/api/settings", json={"default_watermark_text": "@visitor"}).status_code == 200

        # Sign in as boss admin on a second client
        with TestClient(app) as adm:
            assert adm.post("/api/auth/signin", json={"email": "bossadmin@example.com", "password": "RailWayPass99"}).status_code == 200
            me = adm.get("/api/auth/me").json()
            assert me["role"] == "admin"

            ov = adm.get("/api/admin/overview").json()
            assert ov["users"]["total"] >= 3
            assert ov["users"]["online_now"] >= 1
            assert ov["activity_24h"] >= 4
            assert ov["projects"]["total"] >= 1

            # Check per-user summary & last_action
            users_list = adm.get("/api/admin/users").json()
            vis_row = next(row for row in users_list if row["email"] == "newvisitor@example.com")
            assert vis_row["project_count"] == 1
            assert vis_row["online"] is True
            assert vis_row["activity_count"] >= 3
            assert vis_row["last_action"] is not None

            # Activity stream shows exact actions filtered by user & action
            act = adm.get(f"/api/admin/activity?user_id={vid}&action=project_create").json()
            assert act["total"] == 1 and "Visitor Podcast" in act["items"][0]["detail"]

            # All projects view
            projs = adm.get("/api/admin/projects").json()
            assert any(pr["id"] == v_pid and pr["owner"]["email"] == "newvisitor@example.com" for pr in projs)

            # Guardrails: cannot demote or suspend self
            assert adm.patch(f"/api/admin/users/{me['id']}", json={"role": "user"}).status_code == 400
            assert adm.patch(f"/api/admin/users/{me['id']}", json={"is_active": False}).status_code == 400
            assert adm.delete(f"/api/admin/users/{me['id']}").status_code == 400

            # Suspend visitor -> existing cookie returns 403 and signin returns 403
            assert adm.patch(f"/api/admin/users/{vid}", json={"is_active": False}).status_code == 200
            assert v.get("/api/projects").status_code == 403
            assert v.post("/api/auth/signin", json={"email": "newvisitor@example.com", "password": "visitorpass"}).status_code == 403

            # Blocked attempt is audited in activity log
            blocked = adm.get("/api/admin/activity?action=signin_blocked").json()
            assert blocked["total"] >= 1

            # Reactivate + reset password
            assert adm.patch(f"/api/admin/users/{vid}", json={"is_active": True, "new_password": "newpass999"}).status_code == 200
            assert v.post("/api/auth/signin", json={"email": "newvisitor@example.com", "password": "newpass999"}).status_code == 200

            # Delete user cleans up user & owned project cleanly
            assert adm.delete(f"/api/admin/users/{vid}").json() == {"ok": True}
            with session_scope() as s:
                assert s.get(User, vid) is None
                assert s.get(Project, v_pid) is None
                assert s.exec(select(ActivityLog).where(ActivityLog.action == "admin_user_delete")).first() is not None


def test_ytdlp_cookies_and_friendly_bot_error(tmp_path, monkeypatch):
    from app.config import sync_ytdlp_cookies_from_env
    from app.pipeline import ingest as ingest_mod

    init_db()
    with _signed_in(TestClient(app), "me@example.com") as adm:
        # Admin uploads Netscape cookies.txt (returned metadata only, never raw cookie string)
        raw_cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tdemo-value\n"
        r = adm.put("/api/admin/settings", json={"ytdlp_cookies": raw_cookies})
        assert r.status_code == 200
        body = r.json()
        assert body["ytdlp_cookies_configured"] is True
        assert body["ytdlp_cookies_source"] == "saved"
        assert "demo-value" not in r.text

        opts = ingest_mod._ydl_base_opts()
        assert opts.get("cookiefile") == str(get_settings().ytdlp_cookies_path)

        # Friendly bot-verification error mapping
        friendly = ingest_mod._friendly_download_error(
            "Download failed",
            RuntimeError("ERROR: [youtube] demo: Sign in to confirm you're not a bot. Use --cookies for the authentication"),
        )
        assert "Upload Video" in str(friendly) and "cookies.txt" in str(friendly)

        # Admin can clear saved cookies cleanly
        rc = adm.put("/api/admin/settings", json={"ytdlp_cookies": ""})
        assert rc.status_code == 200 and rc.json()["ytdlp_cookies_configured"] is False
        assert "cookiefile" not in ingest_mod._ydl_base_opts()

    # Env var YTDLP_COOKIES sync works with single-line \n escapes too
    monkeypatch.setenv("YTDLP_COOKIES", "# Netscape HTTP Cookie File\\n.youtube.com\tTRUE\t/\tTRUE\t0\tA\tB")
    get_settings.cache_clear()
    try:
        sync_ytdlp_cookies_from_env()
        assert get_settings().effective_ytdlp_cookies_path() == get_settings().ytdlp_cookies_path
    finally:
        monkeypatch.delenv("YTDLP_COOKIES", raising=False)
        get_settings().ytdlp_cookies_path.unlink(missing_ok=True)
        get_settings.cache_clear()



