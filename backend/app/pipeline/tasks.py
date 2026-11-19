"""Job handlers that glue the pipeline together.

analyze_project  ingest -> probe -> audio -> transcribe -> score -> (optional AI) -> create clips -> enqueue renders
render_clip      faces -> layout (scene-cut aware) -> silence cuts -> captions/emoji/hook card -> music/audio polish -> ffmpeg -> thumbnail
analyze_music    bpm / beats / drop for an uploaded song
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
from sqlmodel import select

from ..config import effective_cpus, ffmpeg_thread_count, get_settings, load_runtime_config
from ..db import session_scope
from ..models import BrollClip, Clip, MusicTrack, Project, utcnow
from ..presets import ASPECT_RATIOS, get_caption_style, get_editing_style
from ..queue import cancel_queued, enqueue
from . import audio_analysis, captions, highlights, hook_card, ingest, llm, media, reframe, render, transcribe

log = logging.getLogger(__name__)
ENERGY_STEP = 0.25


def project_dir(project_id: int) -> Path:
    d = get_settings().projects_dir / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


class ProjectGone(BaseException):
    """The project or clip this job was made for was deleted or replaced while it ran."""


def stamp(dt) -> str:
    return dt.isoformat() if dt else ""


def _update_project(project_id: int, *, created: Optional[str] = None, **fields) -> None:
    with session_scope() as s:
        p = s.get(Project, project_id)
        if not p or (created is not None and stamp(p.created_at) != created):
            if created is not None:
                raise ProjectGone(project_id)
            return
        for k, v in fields.items():
            setattr(p, k, v)
        p.updated_at = utcnow()
        s.add(p)
        s.commit()


def _stage(project_id: int, stage: str, progress: float, created: Optional[str] = None) -> None:
    _update_project(project_id, created=created, stage=stage, progress=round(progress, 3), status="processing")


def _still_current(project_id: int, created: str) -> None:
    with session_scope() as s:
        p = s.get(Project, project_id)
        if not p or stamp(p.created_at) != created:
            raise ProjectGone(project_id)


def _is_gone(project_id: int, created: str) -> bool:
    try:
        _still_current(project_id, created)
        return False
    except ProjectGone:
        return True


class _Background:
    def __init__(self, fn: Callable[..., Any], *args, **kwargs):
        self._result: Any = None
        self._error: Optional[BaseException] = None
        self._thread = threading.Thread(target=self._run, args=(fn, args, kwargs), daemon=True, name="scene-scan")
        self._thread.start()

    def _run(self, fn, args, kwargs) -> None:
        try:
            self._result = fn(*args, **kwargs)
        except BaseException as e:  # noqa: BLE001
            self._error = e

    def result(self) -> Any:
        self._thread.join()
        if self._error is not None:
            raise self._error
        return self._result

    def wait(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout)


def _fresh(cache: Path, source: Path) -> bool:
    try:
        st = cache.stat()
        return st.st_size > 0 and st.st_mtime >= source.stat().st_mtime
    except OSError:
        return False


def _write_json(path: Path, obj) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(obj))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def words_for_clip(clip: Clip, pdir: Path) -> list[dict]:
    """Effective clip-relative words for a clip (respects edited words_override if set)."""
    if clip.words_override:
        return [
            {
                "word": str(w.get("word", "")).strip(),
                "start": float(w.get("start", 0.0)),
                "end": float(w.get("end", 0.0)),
            }
            for w in clip.words_override
            if str(w.get("word", "")).strip()
        ]
    tpath = pdir / "transcript.json"
    all_words = _load_json(tpath).get("words", []) if tpath.exists() and isinstance(_load_json(tpath), dict) else []
    return captions.clip_words(all_words, clip.start, clip.end)


# =====================================================================  analyze
def analyze_project(payload: dict) -> None:
    try:
        _analyze(payload)
    except ProjectGone:
        log.info("project %s was deleted or replaced during analysis; stopped", payload.get("project_id"))


def _analyze(payload: dict) -> None:
    pid = int(payload["project_id"])
    mode = payload.get("mode", "rescore")
    with session_scope() as s:
        p = s.get(Project, pid)
        if not p:
            return
        created = stamp(p.created_at)
        if payload.get("created", created) != created:
            return
        source_type, source, source_path = p.source_type, p.source, p.source_path
        source_start, source_end = p.source_start, p.source_end
        settings = dict(p.settings)
        existing_clips = s.exec(select(Clip).where(Clip.project_id == pid)).all()
    pdir = project_dir(pid)

    def stage(text: str, progress: float) -> None:
        _stage(pid, text, progress, created)

    # Non-destructive restyle mode: keep existing clips, edits, approvals & posted history, just re-render
    if mode == "restyle" and existing_clips and source_path and Path(source_path).exists():
        music_ids = list(settings.get("music_track_ids") or [])
        clip_ids: list[tuple[int, str]] = []
        with session_scope() as s:
            p = s.get(Project, pid)
            if not p or stamp(p.created_at) != created:
                raise ProjectGone(pid)
            rows = s.exec(select(Clip).where(Clip.project_id == pid).order_by(Clip.rank)).all()
            for rank, c in enumerate(rows, start=1):
                c.status = "pending"
                c.error = None
                if music_ids and c.music_track_id is None:
                    c.music_track_id = music_ids[(rank - 1) % len(music_ids)]
                s.add(c)
                clip_ids.append((c.id, stamp(c.created_at)))
            s.commit()
        old_map = {cid: cstamp for cid, cstamp in clip_ids}
        cancel_queued("render_clip", lambda pl: same_clip(pl, old_map))
        _update_project(pid, created=created, stage=f"Re-rendering {len(clip_ids)} clips", progress=0.7, status="processing")
        for i, (cid, cstamp) in enumerate(clip_ids):
            enqueue("render_clip", {"clip_id": cid, "created": cstamp}, priority=-i)
        return

    # 1. ingest ----------------------------------------------------------------
    stage("Fetching video", 0.02)
    if source_type == "url":
        have = Path(source_path) if source_path else None
        if have and have.is_file() and have.stat().st_size > 0:
            path = have
        else:
            def dl_progress(f: float):
                stage(f"Downloading video ({int(f * 100)}% of the file)", 0.02 + 0.13 * f)

            try:
                path, title = ingest.download_url(source, pdir, dl_progress, should_stop=lambda: _is_gone(pid, created))
            except ingest.DownloadCancelled:
                raise ProjectGone(pid) from None
            with session_scope() as s:
                p = s.get(Project, pid)
                if not p or stamp(p.created_at) != created:
                    raise ProjectGone(pid)
                if p.name.startswith("http") or not p.name:
                    p.name = title[:120]
                p.source_path = str(path)
                s.add(p)
                s.commit()
    elif source_type == "path":
        path = ingest.resolve_local_path(source, pdir)
        _update_project(pid, created=created, source_path=str(path))
    else:
        path = Path(source_path or "")
        if not path.exists():
            raise media.MediaError("Uploaded file is missing (or raw source was deleted)")

    info = media.probe(path)
    _update_project(pid, created=created, duration=info.duration, width=info.width, height=info.height)
    if info.duration < 8:
        raise media.MediaError("Video is too short (need at least 8 seconds)")

    # 2. scene cuts start now, in the background ---------------------------------
    scenes_path = pdir / "scenes.json"
    cuts = _load_json(scenes_path) if _fresh(scenes_path, path) else None
    stop_scan = threading.Event()
    scan: Optional[_Background] = None
    if not isinstance(cuts, list):
        cuts = None
        spare = max(1, effective_cpus() - transcribe.whisper_cpu_threads())
        scan = _Background(media.scan_scene_changes, path, threads=min(spare, ffmpeg_thread_count()), stop=stop_scan)

    try:
        words: list[dict] = []
        energy = np.zeros(0, dtype=np.float32)
        if info.has_audio:
            energy, words = _analyze_audio(pid, created, stage, pdir, path, info, settings)
            words = [w for w in words if w["start"] < info.duration]

        if scan is not None:
            stage("Detecting scene changes", 0.62)
            try:
                cuts = scan.result()
            except media.MediaError as e:
                log.warning("%s", e)
                cuts = []
            else:
                _still_current(pid, created)
                _write_json(scenes_path, cuts)
    finally:
        stop_scan.set()
        if scan is not None:
            scan.wait(30)

    # 5. scoring (respecting optional source_start / source_end range) ----------
    stage("Scoring viral moments", 0.68)
    win_start = max(0.0, float(source_start or 0.0))
    win_end = min(info.duration, float(source_end)) if source_end and source_end > win_start + 5 else info.duration
    if win_start > 0 or win_end < info.duration:
        sub_dur = win_end - win_start
        sub_words = captions.clip_words(words, win_start, win_end)
        i0 = int(win_start / ENERGY_STEP)
        i1 = int(win_end / ENERGY_STEP) + 1
        sub_energy = energy[i0:i1] if len(energy) else energy
        sub_cuts = [c - win_start for c in (cuts or []) if win_start <= c <= win_end]
        chosen = highlights.select_highlights(
            duration=sub_dur, words=sub_words, energy_db=sub_energy, energy_step=ENERGY_STEP, scene_cuts=sub_cuts,
            count=int(settings.get("clip_count", 20)), min_len=float(settings.get("min_duration", 15)),
            max_len=float(settings.get("max_duration", 60)),
        )
        for c in chosen:
            c.start += win_start
            c.end += win_start
    else:
        chosen = highlights.select_highlights(
            duration=info.duration, words=words, energy_db=energy, energy_step=ENERGY_STEP, scene_cuts=cuts or [],
            count=int(settings.get("clip_count", 20)), min_len=float(settings.get("min_duration", 15)),
            max_len=float(settings.get("max_duration", 60)),
        )
    if not chosen:
        raise media.MediaError("Could not find any usable moments in this video")

    if settings.get("use_ai") and llm.is_configured():
        stage("Refining hooks & scores with AI", 0.69)
        llm.enhance_candidates(chosen)

    music_ids = list(settings.get("music_track_ids") or [])
    with session_scope() as s:
        p = s.get(Project, pid)
        if not p or stamp(p.created_at) != created:
            raise ProjectGone(pid)
        old_ids: dict[int, str] = {}
        for old in s.exec(select(Clip).where(Clip.project_id == pid)).all():
            old_ids[old.id] = stamp(old.created_at)
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
            clip_ids.append((clip.id, stamp(clip.created_at)))
    cancel_queued("render_clip", lambda pl: same_clip(pl, old_ids))
    for oid in old_ids:
        shutil.rmtree(pdir / "clips" / str(oid), ignore_errors=True)
    hour_ago = time.time() - 3600
    for d in (pdir / "clips").glob("*.*-*"):
        try:
            if d.is_dir() and d.stat().st_mtime < hour_ago:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass
    keep = {_face_cache_name(round(c.start, 3), round(c.end, 3)) for c in chosen}
    for f in (pdir / "faces").glob("*.json"):
        if f.name not in keep:
            f.unlink(missing_ok=True)

    _update_project(pid, created=created, stage=f"Rendering {len(clip_ids)} clips", progress=0.7, status="processing")
    for i, (cid, cstamp) in enumerate(clip_ids):
        enqueue("render_clip", {"clip_id": cid, "created": cstamp}, priority=-i)


def _analyze_audio(pid: int, created: str, stage: Callable[[str, float], None], pdir: Path, path: Path, info,
                   settings: dict) -> tuple[np.ndarray, list[dict]]:
    epath, tpath = pdir / "energy.npy", pdir / "transcript.json"
    backend = get_settings().transcribe_backend.lower()
    language = settings.get("language") or None

    tr = _load_json(tpath) if _fresh(tpath, path) else None
    if isinstance(tr, dict):
        if tr.get("backend", backend) != backend or tr.get("requested_language", language) != language:
            tr = None
        elif "backend" not in tr and not tr.get("words") and backend != "none":
            tr = None
    else:
        tr = None
    energy = None
    if _fresh(epath, path):
        try:
            energy = np.load(epath)
        except (OSError, ValueError):
            energy = None

    if tr is None or energy is None:
        wav = pdir / "audio16k.wav"
        try:
            stage("Extracting audio", 0.16)
            media.extract_audio(path, wav, duration=info.duration,
                                on_progress=lambda f: stage("Extracting audio", 0.16 + 0.04 * f))
            if energy is None:
                try:
                    energy = audio_analysis.energy_curve_wav(wav, ENERGY_STEP)
                except (ValueError, EOFError, OSError):
                    energy = audio_analysis.energy_curve(media.load_pcm(wav, sr=16000), 16000, ENERGY_STEP)
                _still_current(pid, created)
                tmp = epath.with_name(f"energy.npy.{os.getpid()}-{threading.get_ident()}.tmp")
                try:
                    with open(tmp, "wb") as fh:
                        np.save(fh, energy)
                    os.replace(tmp, epath)
                finally:
                    tmp.unlink(missing_ok=True)
            if tr is None:
                stage("Transcribing speech (Whisper)", 0.2)
                minutes = int(-(-info.duration // 60))

                def tr_progress(f: float):
                    where = f", minute {min(minutes, int(f * info.duration / 60) + 1)} of {minutes}" if minutes > 2 else ""
                    stage(f"Transcribing speech{where}", 0.2 + 0.4 * f)

                tr = transcribe.transcribe(wav, language, tr_progress, info.duration)
                tr["backend"], tr["requested_language"] = backend, language
                _still_current(pid, created)
                _write_json(tpath, tr)
        finally:
            wav.unlink(missing_ok=True)
    return energy, tr.get("words", [])


# =====================================================================  render
def _emphasis_windows(words: list[dict], energy: np.ndarray, clip_start: float, gap: float = 3.0,
                      beats: list[float] | None = None, music_offset: float = 0.0, speed: float = 1.0) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    if len(energy):
        ref = energy[energy > -55]
        mu, sd = (float(ref.mean()), float(ref.std() + 1e-6)) if len(ref) else (0.0, 1.0)
    clip_beats = [b - music_offset for b in (beats or []) if 0.2 <= (b - music_offset) <= 180.0]

    def snap(t: float) -> float:
        if not clip_beats:
            return t
        nearest = min(clip_beats, key=lambda b: abs(b - t))
        return nearest if abs(nearest - t) <= 0.35 else t

    for w in words:
        loud = False
        if len(energy):
            i = int((w["start"] * speed + clip_start) / ENERGY_STEP)
            if 0 <= i < len(energy):
                loud = (energy[i] - mu) / sd > 1.3
        if captions.is_keyword(w["word"]) or loud or w["word"].endswith("!"):
            t0 = max(0.0, snap(w["start"]))
            if not out or t0 - out[-1][0] >= gap:
                out.append((t0, min(t0 + 1.1, w["end"] + 0.6)))
    if not out and clip_beats:
        for b in clip_beats[::8][:12]:
            if not out or b - out[-1][0] >= gap:
                out.append((b, b + 0.9))
    return out


def _hook_time(words: list[dict], dur: float) -> float:
    for w in words:
        if 0.8 <= w["start"] <= min(6.0, dur / 3) and captions.is_keyword(w["word"]):
            return w["start"]
    for w in words:
        if re.search(r"[.!?؟]$", w["word"]) and w["end"] < dur / 2:
            return w["end"]
    return min(1.5, dur / 4)


def _face_cache_name(start: float, end: float) -> str:
    return f"{start:.3f}-{end:.3f}.json"


def same_clip(payload: dict, clips: dict[int, str]) -> bool:
    cid = payload.get("clip_id")
    return cid in clips and payload.get("created", clips[cid]) == clips[cid]


def _face_track(pdir: Path, source: Path, start: float, end: float,
                still_current: Callable[[], None] = lambda: None) -> reframe.FaceTrack:
    cache = pdir / "faces" / _face_cache_name(start, end)
    data = _load_json(cache) if _fresh(cache, source) else None
    if isinstance(data, dict) and data.get("times"):
        try:
            return reframe.FaceTrack.from_dict(data)
        except (ValueError, TypeError, IndexError, KeyError, AttributeError):
            pass
    track = reframe.analyze_faces(source, start, end)
    still_current()
    if track.times:
        try:
            cache.parent.mkdir(exist_ok=True)
            _write_json(cache, track.to_dict())
        except OSError:
            log.debug("could not save face track", exc_info=True)
    return track


_inflight: dict[int, tuple[int, float]] = {}
_inflight_lock = threading.Lock()
_last_progress_write: dict[int, float] = {}
FACE_SHARE = 0.12


def _set_inflight(cid: int, pid: int, fraction: float) -> None:
    with _inflight_lock:
        _inflight[cid] = (pid, max(0.0, min(1.0, fraction)))
    refresh_project_progress(pid, throttle=True)


def render_clip(payload: dict) -> None:
    try:
        _render(payload)
    except ProjectGone:
        log.info("clip %s was deleted or replaced while it rendered; result dropped", payload.get("clip_id"))


def _clip_current(cid: int, created: str) -> None:
    with session_scope() as s:
        clip = s.get(Clip, cid)
        if not clip or stamp(clip.created_at) != created:
            raise ProjectGone(cid)


def _render(payload: dict) -> None:
    cid = int(payload["clip_id"])
    s_cfg = get_settings()
    with session_scope() as s:
        clip = s.get(Clip, cid)
        if not clip:
            return
        created = stamp(clip.created_at)
        if payload.get("created", created) != created:
            return
        pid = clip.project_id
    with _inflight_lock:
        busy = cid in _inflight
        if not busy:
            _inflight[cid] = (pid, 0.0)
    if busy:
        enqueue("render_clip", {"clip_id": cid, "created": created}, priority=8, delay_seconds=5)
        return

    work: Optional[Path] = None
    retired: Optional[Path] = None
    try:
        with session_scope() as s:
            clip = s.get(Clip, cid)
            if not clip or stamp(clip.created_at) != created:
                raise ProjectGone(cid)
            proj = s.get(Project, clip.project_id)
            if not proj or not proj.source_path or not Path(proj.source_path).exists():
                raise media.MediaError("Source video is no longer on disk (it may have been deleted to free space)")
            clip.status = "rendering"
            clip.error = None
            s.add(clip)
            s.commit()
            start, end, hook_text = clip.start, clip.end, clip.hook or clip.title
            settings = {**dict(proj.settings), **dict(clip.overrides or {})}
            source = Path(proj.source_path)
            music = s.get(MusicTrack, clip.music_track_id) if clip.music_track_id else None
            music_info = (Path(music.path), music.drop_time, list(music.beats or [])) if music else None
            broll_id = settings.get("broll_id")
            broll = s.get(BrollClip, int(broll_id)) if broll_id else None
            broll_path = Path(broll.path) if broll and Path(broll.path).exists() else None
            words_override = list(clip.words_override) if clip.words_override else None
        refresh_project_progress(pid, throttle=True)

        pdir = project_dir(pid)
        for pattern in (f"{cid}.part-*", f"{cid}.old-*"):
            for d in (pdir / "clips").glob(pattern):
                shutil.rmtree(d, ignore_errors=True)
        work = pdir / "clips" / f"{cid}.part-{uuid.uuid4().hex[:8]}"
        work.mkdir(parents=True)

        out_w, out_h = ASPECT_RATIOS.get(settings.get("aspect_ratio", "9:16"), (s_cfg.output_width, s_cfg.output_height))
        style = get_editing_style(settings.get("editing_style", "face_track_zoom"))
        cap_style = get_caption_style(settings.get("caption_style", "hormozi"))
        src_dur = end - start
        speed = max(0.75, min(1.5, float(settings.get("playback_speed", 1.0) or 1.0)))
        has_speed = abs(speed - 1.0) > 1e-3
        video_effect = str(settings.get("video_effect", "none") or "none")

        tpath = pdir / "transcript.json"
        if words_override:
            words = [{"word": str(w["word"]).strip(), "start": float(w["start"]), "end": float(w["end"])}
                     for w in words_override if str(w.get("word", "")).strip()]
        else:
            all_words = json.loads(tpath.read_text()).get("words", []) if tpath.exists() else []
            words = captions.clip_words(all_words, start, end)

        energy = np.load(pdir / "energy.npy") if (pdir / "energy.npy").exists() else np.zeros(0)
        scenes_all = _load_json(pdir / "scenes.json")
        scene_cuts = [float(c) - start for c in (scenes_all or []) if start < float(c) < end] if isinstance(scenes_all, list) else []
        info = media.probe(source)

        # optional silence removal (jump-cut)
        keep_segments = None
        dur = src_dur
        if settings.get("remove_silences") and words and not words_override:
            segs = highlights.silence_cuts(words, src_dur)
            if len(segs) > 1:
                keep_segments = segs
                words = captions.remap_words_after_cuts(words, segs)
                dur = sum(b - a for a, b in segs)

        # reframe
        layout = style.get("layout", "face_track")
        track = reframe.FaceTrack() if layout in ("center", "blur_fill") else _face_track(
            pdir, source, start, end, lambda: _clip_current(cid, created))
        _set_inflight(cid, pid, FACE_SHARE)

        if has_speed:
            words = [{**w, "start": round(w["start"] / speed, 3), "end": round(w["end"] / speed, 3)} for w in words]
            track = reframe.FaceTrack(times=[t / speed for t in track.times], faces=track.faces)
            scene_cuts = [c / speed for c in scene_cuts]
            dur = dur / speed

        music_offset = 0.0
        beats_list: list[float] = []
        if music_info and music_info[0].exists():
            _, drop, beats_list = music_info
            if settings.get("match_drop_to_hook", True) and drop:
                music_offset = float(drop) - _hook_time(words, dur)

        use_beats = bool(settings.get("beat_sync_zoom", False))
        zooms = _emphasis_windows(
            words, energy, start,
            beats=beats_list if use_beats else None,
            music_offset=music_offset,
            speed=speed,
        ) if (style.get("zoom_on_emphasis") or use_beats) else []

        lay = reframe.build_layout(
            layout, src_w=info.width, src_h=info.height, out_w=out_w, out_h=out_h,
            track=track, style=style, zoom_windows=zooms, scene_cuts=scene_cuts,
            has_broll=broll_path is not None,
        )

        runtime_cfg = load_runtime_config()
        wm_text = settings.get("watermark_text")
        if wm_text is None:
            wm_text = runtime_cfg.get("default_watermark_text", "")
        wm_pos = settings.get("watermark_position") or runtime_cfg.get("default_watermark_position", "bottom_right")

        spec = render.RenderSpec(
            source=source, start=start, end=end, out_path=work / "clip.mp4", work_dir=work,
            video_filter=lay.filter, out_w=out_w, out_h=out_h, has_audio=info.has_audio,
            broll_path=broll_path if lay.layout_used == "broll_split" else None,
            keep_segments=keep_segments,
            normalize_audio=bool(settings.get("normalize_audio", True)),
            denoise_audio=bool(settings.get("denoise_audio", False)),
            progress_bar=bool(settings.get("progress_bar", False)),
            watermark_text=str(wm_text or ""),
            watermark_position=str(wm_pos),
            video_effect=video_effect,
            speed=speed,
            fps=info.fps,
        )

        # captions
        caption_y = settings.get("caption_position") or style.get("caption_y", 0.62)
        if lay.layout_used in ("split_faces", "gameplay_facecam", "broll_split") and not settings.get("caption_position"):
            caption_y = 0.55 if lay.layout_used in ("gameplay_facecam", "broll_split") else 0.5
        if cap_style and words:
            ass, cues = captions.build_ass(words, cap_style, out_w=out_w, out_h=out_h, caption_y=caption_y,
                                           clip_duration=dur, auto_emoji=bool(settings.get("auto_emoji", True)))
            spec.ass_path = captions.write_ass(work / "captions.ass", ass)
            spec.emoji = cues
            scale_factor = min(out_w, out_h) / 1080.0
            cap_px = int(cap_style.get("size", 90)) * scale_factor
            em_offset = int(cap_px * 1.45 + 140 * scale_factor)
            spec.emoji_y = max(int(out_h * 0.04), int(out_h * caption_y) - em_offset)

        # hook title card
        if (style.get("hook_card") or settings.get("hook_title")) and hook_text:
            png, cw, ch = hook_card.render_hook_card(
                hook_text, work / "hook.png", out_w=out_w,
                card_style=str(settings.get("hook_card_style", "light")),
            )
            if lay.layout_used == "blur_fill":
                fg_h = out_w * info.height / info.width
                fg_top = (out_h - fg_h) * float(style.get("foreground_y", 0.5))
                y = int(max(24, fg_top - ch - 20))
            else:
                y = int(out_h * 0.08)
            spec.hook_png, spec.hook_xy = png, ((out_w - cw) // 2, y)
            spec.hook_duration = float(settings.get("hook_card_duration", 0.0) or 0.0)

        # music + drop sync
        if music_info and music_info[0].exists():
            mpath = music_info[0]
            spec.music = render.MusicSpec(
                path=mpath, offset=music_offset,
                volume=float(settings.get("music_volume", 0.18)),
                ducking=bool(settings.get("ducking", True)),
            )

        last_check = [time.monotonic()]

        def on_progress(f: float) -> None:
            _set_inflight(cid, pid, FACE_SHARE + (1 - FACE_SHARE) * f)
            if time.monotonic() - last_check[0] >= 5:
                last_check[0] = time.monotonic()
                _clip_current(cid, created)

        render.render(spec, on_progress)
        media.make_thumbnail(spec.out_path, work / "thumb.jpg", at=min(1.5, dur / 2))

        final = pdir / "clips" / str(cid)
        with session_scope() as s:
            clip = s.get(Clip, cid)
            if not clip or stamp(clip.created_at) != created:
                raise ProjectGone(cid)
            if final.exists():
                retired = final.with_name(f"{cid}.old-{uuid.uuid4().hex[:8]}")
                os.replace(final, retired)
            try:
                os.replace(work, final)
            except OSError:
                if retired is not None:
                    os.replace(retired, final)
                    retired = None
                raise
            work = None
            clip.status, clip.video_path, clip.thumb_path = "ready", str(final / "clip.mp4"), str(final / "thumb.jpg")
            clip.error = None
            clip.score_breakdown = {**clip.score_breakdown, "layout": lay.layout_used}
            clip.updated_at = utcnow()
            s.add(clip)
            s.commit()
    except Exception as e:
        with session_scope() as s:
            clip = s.get(Clip, cid)
            if clip and stamp(clip.created_at) == created:
                clip.status, clip.error = "failed", str(e)[-800:]
                s.add(clip)
                s.commit()
        raise
    finally:
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)
        elif retired is not None:
            shutil.rmtree(retired, ignore_errors=True)
        with _inflight_lock:
            _inflight.pop(cid, None)
        refresh_project_progress(pid)


def refresh_project_progress(pid: int, final: bool = False, throttle: bool = False) -> None:
    with _inflight_lock:
        now = time.monotonic()
        if throttle and now - _last_progress_write.get(pid, 0.0) < 1.0:
            return
        _last_progress_write[pid] = now
        running = [f for (p_id, f) in _inflight.values() if p_id == pid]
    with session_scope() as s:
        p = s.get(Project, pid)
        clips = s.exec(select(Clip).where(Clip.project_id == pid)).all()
        if not p or not clips:
            return
        done = [c for c in clips if c.status in ("ready", "failed")]
        ready = [c for c in clips if c.status == "ready"]
        n = len(clips)
        if len(done) == n:
            p.status = "done" if ready else "failed"
            p.stage = f"{len(ready)} of {n} clips ready"
            if not ready:
                p.error = "All clip renders failed: " + (clips[0].error or "")[:300]
            p.progress = 1.0
        else:
            running = running[: n - len(done)]
            p.progress = round(0.7 + 0.3 * (len(done) + sum(running)) / n, 3)
            if len(running) == 1:
                p.stage = f"Rendering clip {len(done) + 1} of {n}"
            elif running:
                p.stage = f"Rendering clips {len(done) + 1} to {len(done) + len(running)} of {n}"
            else:
                p.stage = f"Rendered {len(done)} of {n} clips"
        p.updated_at = utcnow()
        s.add(p)
        s.commit()


def fail_clip(payload: dict, error: str) -> None:
    if not payload.get("clip_id"):
        return
    pid = None
    with session_scope() as s:
        clip = s.get(Clip, int(payload["clip_id"]))
        if clip and payload.get("created", stamp(clip.created_at)) != stamp(clip.created_at):
            clip = None
        if clip and clip.status != "ready":
            clip.status, clip.error = "failed", error[-800:]
            s.add(clip)
            s.commit()
            pid = clip.project_id
    if pid:
        refresh_project_progress(pid)


def fail_project(payload: dict, error: str) -> None:
    if not payload.get("project_id"):
        return
    try:
        _update_project(int(payload["project_id"]), created=payload.get("created"), status="failed",
                        error=error[-800:], stage="Failed")
    except ProjectGone:
        pass


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
        if not t:
            return
        t.bpm, t.beats, t.drop_time, t.duration, t.analyzed = info["bpm"], info["beats"], info["drop_time"], dur, True
        s.add(t)
        s.commit()
