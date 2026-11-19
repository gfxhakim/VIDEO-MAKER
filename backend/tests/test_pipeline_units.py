"""Fast unit tests: no FFmpeg or models needed."""
import numpy as np

from app.pipeline import captions, highlights, reframe
from app.presets import caption_styles, editing_styles, get_caption_style


def _words(n=300, wps=2.8):
    text = ("Here's why nobody tells you the truth about money. I made a million dollars in six months! "
            "Most people never start because they are scared. Did you know the biggest mistake is waiting? ").split()
    out, t = [], 0.5
    for i in range(n):
        w = text[i % len(text)]
        out.append({"word": w, "start": t, "end": t + 1 / wps - 0.05})
        t += 1 / wps + (0.4 if w[-1] in ".!?" else 0)
    return out


def test_presets_are_valid():
    assert {"face_track_zoom", "podcast_split", "talking_head", "gaming_fast"} <= set(editing_styles())
    assert {"hormozi", "netflix_kinetic", "neon_glow", "minimal_clean"} <= set(caption_styles())
    for s in editing_styles().values():
        assert s["layout"] in {"face_track", "face_static", "split_faces", "gameplay_facecam", "broll_split", "blur_fill", "center"}


def test_select_highlights_respects_count_length_and_overlap():
    words = _words()
    dur = words[-1]["end"] + 1
    energy = np.random.default_rng(0).normal(-25, 4, int(dur / 0.25) + 1).astype(np.float32)
    clips = highlights.select_highlights(duration=dur, words=words, energy_db=energy, energy_step=0.25, scene_cuts=[],
                                         count=10, min_len=15, max_len=40)
    assert 1 <= len(clips) <= 10
    for c in clips:
        assert 14 <= c.duration <= 41
        assert 0 <= c.score <= 100
    scores = [c.score for c in clips]
    assert scores == sorted(scores, reverse=True)


def test_select_highlights_without_speech():
    energy = np.full(4 * 300, -30, dtype=np.float32)
    energy[400:440] = -8  # a loud moment
    clips = highlights.select_highlights(duration=300, words=[], energy_db=energy, energy_step=0.25, scene_cuts=[],
                                         count=10, min_len=15, max_len=30)
    assert len(clips) == 10
    assert any(c.start <= 100 <= c.end for c in clips[:3])  # loud part ranks high


def test_ass_events_never_overlap_for_chunk_mode():
    style = get_caption_style("hormozi")
    words = captions.clip_words(_words(60), 0, 20)
    ass, _ = captions.build_ass(words, style, out_w=1080, out_h=1920, caption_y=0.6, clip_duration=20)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue: 0,")]
    assert events

    def t(s):
        h, m, sec = s.split(":")
        return int(h) * 3600 + int(m) * 60 + float(sec)

    spans = sorted((t(e.split(",")[1]), t(e.split(",")[2])) for e in events)
    for (a0, b0), (a1, _) in zip(spans, spans[1:]):
        assert b0 <= a1 + 1e-6


def test_emoji_lookup():
    assert captions.emoji_for("money") == "💰"
    assert captions.emoji_for("laughing") == "😂"
    assert captions.emoji_for("the") is None


def test_piecewise_expr_is_compact():
    times = [i * 0.25 for i in range(400)]
    vals = [300 + 200 * np.sin(t / 5) for t in times]
    expr = reframe.piecewise_expr(times, vals, max_points=40)
    assert expr.count("gte(t") <= 41
    assert reframe.piecewise_expr([0, 1, 2], [10, 10, 10]) == "10.0"


def test_layout_fallbacks():
    empty = reframe.FaceTrack()
    style = editing_styles()["podcast_split"]
    res = reframe.build_layout("split_faces", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=empty, style=style)
    assert res.layout_used == "center" and "[vbase]" in res.filter
    res = reframe.build_layout("blur_fill", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=empty, style={})
    assert "gblur" in res.filter


def test_split_faces_detects_two_speakers():
    tr = reframe.FaceTrack(times=[i * 0.25 for i in range(40)],
                           faces=[[(0.25, 0.4, 0.1, 0.18), (0.75, 0.42, 0.1, 0.18)] for _ in range(40)])
    res = reframe.build_layout("split_faces", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=tr, style={})
    assert res.layout_used == "split_faces" and "vstack" in res.filter
