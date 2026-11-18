"""End-to-end render on a synthetic video (needs FFmpeg; skipped otherwise)."""
import json
import shutil
import subprocess

import pytest

from app.db import init_db, session_scope
from app.models import Clip, Project
from app.pipeline import media, tasks

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


@pytest.mark.parametrize("editing,caption", [("center_crop", "hormozi"), ("blur_fill_reaction", "neon_glow"), ("face_track_zoom", "gaming_stack")])
def test_generate_and_render(tmp_path, monkeypatch, editing, caption):
    init_db()
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=40:r=30",
                    "-f", "lavfi", "-i", "sine=f=220:d=40", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    queued = []
    monkeypatch.setattr(tasks, "enqueue", lambda kind, payload, **k: queued.append(payload))
    with session_scope() as s:
        p = Project(name="t", source_type="path", source=str(src),
                    settings={"clip_count": 10, "min_duration": 10, "max_duration": 15, "editing_style": editing,
                              "caption_style": caption, "auto_emoji": True})
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id
    words = [{"word": w, "start": 0.5 + i * 0.4, "end": 0.8 + i * 0.4}
             for i, w in enumerate(("Here's why money changed my life forever! " * 12).split())]
    (tasks.project_dir(pid) / "transcript.json").write_text(json.dumps({"words": words, "segments": []}))
    tasks.analyze_project({"project_id": pid})
    assert queued, "no clips were queued"
    tasks.render_clip(queued[0])
    with session_scope() as s:
        clip = s.get(Clip, queued[0]["clip_id"])
        assert clip.status == "ready", clip.error
        info = media.probe(clip.video_path)
        assert (info.width, info.height) == (1080, 1920)
        assert info.has_audio
