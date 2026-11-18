"""Job handlers that glue the pipeline together.

analyze_project  ingest -> probe -> audio -> transcribe -> score -> create clips -> enqueue renders
render_clip      faces -> layout -> captions/emoji/hook card -> music -> ffmpeg -> thumbnail
analyze_music    bpm / beats / drop for an uploaded song

Each clip renders as its own job, so one bad clip never sinks the whole project and
renders can run in parallel (WORKER_CONCURRENCY).
"""
from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path

import numpy as np
from sqlmodel import select

from ..config import get_settings
from ..db import session_scope
from ..models import Clip, MusicTrack, Project, utcnow
from ..presets import ASPECT_RATIOS, get_caption_style, get_editing_style
from ..queue import enqueue
from . import audio_analysis, captions, highlights, hook_card, ingest, media, reframe, render, transcribe

log = logging.getLogger(__name__)
ENERGY_STEP = 0.25


def project_dir(project_id: int) -> Path:
    d = get_settings().projects_dir / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _update_project(project_id: int, **fields) -> None:
    with session_scope() as s:
        p = s.get(Project, project_id)
        if not p:
            return
        for k, v in fields.items():
            setattr(p, k, v)
        p.updated_at = utcnow()
        s.add(p)
        s.commit()


def _stage(project_id: int, stage: str, progress: float) -> None:
    _update_project(project_id, stage=stage, progress=round(progress, 3), status="processing")


# =====================================================================  analyze
def analyze_project(payload: dict) -> None:
    pid = int(payload["project_id"])
    with session_scope() as s:
        p = s.get(Project, pid)
        if not p:
            return
        source_type, source, source_path, settings = p.source_type, p.source, p.source_path, dict(p.settings)
    pdir = project_dir(pid)

    # 1. ingest ----------------------------------------------------------------
    _stage(pid, "Fetching video", 0.02)
    if source_type == "url":
        def dl_progress(f: float):
            _stage(pid, f"Downloading video {int(f * 100)}%", 0.02 + 0.13 * f)

        path, title = ingest.download_url(source, pdir, dl_progress)
        with session_scope() as s:
            p = s.get(Project, pid)
            if p.name.startswith("http") or not p.name:
                p.name = title[:120]
            p.source_path = str(path)
            s.add(p)
            s.commit()
    elif source_type == "path":
        path = ingest.resolve_local_path(source, pdir)
        _update_project(pid, source_path=str(path))
    else:
        path = Path(source_path or "")
        if not path.exists():
            raise media.MediaError("Uploaded file is missing")

    info = media.probe(path)
    _update_project(pid, duration=info.duration, width=info.width, height=info.height)
    if info.duration < 8:
        raise media.MediaError("Video is too short (need at least 8 seconds)")

    # 2. audio + transcript -----------------------------------------------------
    _stage(pid, "Extracting audio", 0.16)
    wav = pdir / "audio16k.wav"
    words: list[dict] = []
    energy = np.zeros(0, dtype=np.float32)
    if info.has_audio:
        media.extract_audio(path, wav)
        pcm = media.load_pcm(wav, sr=16000)
        energy = audio_analysis.energy_curve(pcm, 16000, ENERGY_STEP)
        np.save(pdir / "energy.npy", energy)

        tpath = pdir / "transcript.json"
        if tpath.exists():
            tr = json.loads(tpath.read_text())
        else:
            _stage(pid, "Transcribing speech (Whisper)", 0.2)

            def tr_progress(f: float):
                _stage(pid, f"Transcribing speech {int(f * 100)}%", 0.2 + 0.4 * f)

            tr = transcribe.transcribe(wav, settings.get("language"), tr_progress, info.duration)
            tpath.write_text(json.dumps(tr))
        words = tr.get("words", [])

    # 3. visual activity ------------------------------------------------------
    _stage(pid, "Detecting scene changes", 0.62)
    cuts = media.detect_scene_changes(path)
    (pdir / "scenes.json").write_text(json.dumps(cuts))

    # 4. scoring --------------------------------------------------------------
    _stage(pid, "Scoring viral moments", 0.68)
    chosen = highlights.select_highlights(
        duration=info.duration, words=words, energy_db=energy, energy_step=ENERGY_STEP, scene_cuts=cuts,
        count=int(settings.get("clip_count", 20)), min_len=float(settings.get("min_duration", 15)),
        max_len=float(settings.get("max_duration", 60)),
    )
    if not chosen:
        raise media.MediaError("Could not find any usable moments in this video")

    music_ids = list(settings.get("music_track_ids") or [])
    with session_scope() as s:
        # re-runs replace earlier clips
        for old in s.exec(select(Clip).where(Clip.project_id == pid)).all():
            s.delete(old)
        s.commit()
        clip_ids = []
        for rank, c in enumerate(chosen, start=1):
            clip = Clip(
                project_id=pid, rank=rank, start=round(c.start, 3), end=round(c.end, 3), score=c.score,
                score_breakdown=c.breakdown, transcript=c.text, hook=highlights.make_title(c.hook, c.text, 90),
                title=highlights.make_title(c.hook, c.text), hashtags=highlights.make_hashtags(c.text),
                description=(c.text[:280] + ("…" if len(c.text) > 280 else "")),
                music_track_id=music_ids[(rank - 1) % len(music_ids)] if music_ids else None,
                status="pending",
            )
            s.add(clip)
            s.commit()
            s.refresh(clip)
            clip_ids.append(clip.id)
    _update_project(pid, stage=f"Rendering {len(clip_ids)} clips", progress=0.7, status="processing")
    for i, cid in enumerate(clip_ids):
        enqueue("render_clip", {"clip_id": cid}, priority=-i)


# =====================================================================  render
def _emphasis_windows(words: list[dict], energy: np.ndarray, clip_start: float, gap: float = 3.0) -> list[tuple[float, float]]:
    """Moments for punch-in zooms: keywords or loudness spikes, at most one every `gap` s."""
    out: list[tuple[float, float]] = []
    if len(energy):
        ref = energy[energy > -55]
        mu, sd = (float(ref.mean()), float(ref.std() + 1e-6)) if len(ref) else (0.0, 1.0)
    for w in words:
        loud = False
        if len(energy):
            i = int((w["start"] + clip_start) / ENERGY_STEP)
            if 0 <= i < len(energy):
                loud = (energy[i] - mu) / sd > 1.3
        if captions.is_keyword(w["word"]) or loud or w["word"].endswith("!"):
            if not out or w["start"] - out[-1][0] >= gap:
                out.append((w["start"], min(w["start"] + 1.1, w["end"] + 0.6)))
    return out


def _hook_time(words: list[dict], dur: float) -> float:
    for w in words:
        if 0.8 <= w["start"] <= min(6.0, dur / 3) and captions.is_keyword(w["word"]):
            return w["start"]
    for w in words:  # end of the first sentence
        if re.search(r"[.!?]$", w["word"]) and w["end"] < dur / 2:
            return w["end"]
    return min(1.5, dur / 4)


def render_clip(payload: dict) -> None:
    cid = int(payload["clip_id"])
    s_cfg = get_settings()
    with session_scope() as s:
        clip = s.get(Clip, cid)
        if not clip:
            return
        proj = s.get(Project, clip.project_id)
        clip.status = "rendering"
        clip.error = None
        s.add(clip)
        s.commit()
        pid, start, end, hook_text = proj.id, clip.start, clip.end, clip.hook or clip.title
        settings, source = dict(proj.settings), Path(proj.source_path)
        src_w, src_h = proj.width or 1920, proj.height or 1080
        music = s.get(MusicTrack, clip.music_track_id) if clip.music_track_id else None
        music_info = (Path(music.path), music.drop_time) if music else None

    try:
        pdir = project_dir(pid)
        work = pdir / "clips" / f"{cid}"
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True)
        out_w, out_h = ASPECT_RATIOS.get(settings.get("aspect_ratio", "9:16"), (s_cfg.output_width, s_cfg.output_height))
        style = get_editing_style(settings.get("editing_style", "face_track_zoom"))
        cap_style = get_caption_style(settings.get("caption_style", "hormozi"))
        dur = end - start

        tpath = pdir / "transcript.json"
        all_words = json.loads(tpath.read_text()).get("words", []) if tpath.exists() else []
        words = captions.clip_words(all_words, start, end)
        energy = np.load(pdir / "energy.npy") if (pdir / "energy.npy").exists() else np.zeros(0)
        info = media.probe(source)

        # reframe
        layout = style.get("layout", "face_track")
        track = reframe.FaceTrack() if layout in ("center", "blur_fill") else reframe.analyze_faces(source, start, end)
        zooms = _emphasis_windows(words, energy, start) if style.get("zoom_on_emphasis") else []
        lay = reframe.build_layout(layout, src_w=info.width, src_h=info.height, out_w=out_w, out_h=out_h,
                                   track=track, style=style, zoom_windows=zooms)

        spec = render.RenderSpec(source=source, start=start, end=end, out_path=work / "clip.mp4", work_dir=work,
                                 video_filter=lay.filter, out_w=out_w, out_h=out_h, has_audio=info.has_audio)

        # captions
        caption_y = settings.get("caption_position") or style.get("caption_y", 0.62)
        if lay.layout_used in ("split_faces", "gameplay_facecam"):
            caption_y = 0.55 if lay.layout_used == "gameplay_facecam" else 0.5
        if cap_style and words:
            ass, cues = captions.build_ass(words, cap_style, out_w=out_w, out_h=out_h, caption_y=caption_y,
                                           clip_duration=dur, auto_emoji=bool(settings.get("auto_emoji", True)))
            spec.ass_path = captions.write_ass(work / "captions.ass", ass)
            spec.emoji = cues
            spec.emoji_y = max(40, int(out_h * caption_y) - int(cap_style.get("size", 90)) - 190)

        # hook title card
        if (style.get("hook_card") or settings.get("hook_title")) and hook_text:
            png, cw, ch = hook_card.render_hook_card(hook_text, work / "hook.png", out_w=out_w)
            if lay.layout_used == "blur_fill":
                fg_h = out_w * info.height / info.width
                fg_top = (out_h - fg_h) * float(style.get("foreground_y", 0.5))
                y = int(max(60, fg_top - ch - 28))
            else:
                y = int(out_h * 0.1)
            spec.hook_png, spec.hook_xy = png, ((out_w - cw) // 2, y)

        # music + drop sync
        if music_info and music_info[0].exists():
            mpath, drop = music_info
            offset = 0.0
            if settings.get("match_drop_to_hook", True) and drop:
                offset = float(drop) - _hook_time(words, dur)
            spec.music = render.MusicSpec(path=mpath, offset=offset, volume=float(settings.get("music_volume", 0.18)),
                                          ducking=bool(settings.get("ducking", True)))

        render.render(spec)
        thumb = media.make_thumbnail(spec.out_path, work / "thumb.jpg", at=min(1.5, dur / 2))
        with session_scope() as s:
            clip = s.get(Clip, cid)
            clip.status, clip.video_path, clip.thumb_path = "ready", str(spec.out_path), str(thumb)
            clip.score_breakdown = {**clip.score_breakdown, "layout": lay.layout_used}
            clip.updated_at = utcnow()
            s.add(clip)
            s.commit()
    except Exception as e:
        with session_scope() as s:
            clip = s.get(Clip, cid)
            if clip:
                clip.status, clip.error = "failed", str(e)[-800:]
                s.add(clip)
                s.commit()
        raise
    finally:
        refresh_project_progress(pid)


def refresh_project_progress(pid: int, final: bool = False) -> None:
    with session_scope() as s:
        p = s.get(Project, pid)
        clips = s.exec(select(Clip).where(Clip.project_id == pid)).all()
        if not p or not clips:
            return
        done = [c for c in clips if c.status in ("ready", "failed")]
        ready = [c for c in clips if c.status == "ready"]
        p.progress = round(0.7 + 0.3 * len(done) / len(clips), 3)
        if len(done) == len(clips):
            p.status = "done" if ready else "failed"
            p.stage = f"{len(ready)} of {len(clips)} clips ready"
            if not ready:
                p.error = "All clip renders failed: " + (clips[0].error or "")[:300]
            p.progress = 1.0
        else:
            p.stage = f"Rendered {len(done)} of {len(clips)} clips"
        p.updated_at = utcnow()
        s.add(p)
        s.commit()


def fail_project(payload: dict, error: str) -> None:
    if payload.get("project_id"):
        _update_project(int(payload["project_id"]), status="failed", error=error[-800:], stage="Failed")


# =====================================================================  music
def analyze_music(payload: dict) -> None:
    tid = int(payload["track_id"])
    with session_scope() as s:
        t = s.get(MusicTrack, tid)
        if not t:
            return
        path = Path(t.path)
    info = audio_analysis.analyze_music(path)
    dur = None
    try:
        out = media.run([get_settings().ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
        dur = float(out.stdout.decode().strip() or 0)
    except Exception:  # noqa: BLE001
        pass
    with session_scope() as s:
        t = s.get(MusicTrack, tid)
        t.bpm, t.beats, t.drop_time, t.duration, t.analyzed = info["bpm"], info["beats"], info["drop_time"], dur, True
        s.add(t)
        s.commit()
