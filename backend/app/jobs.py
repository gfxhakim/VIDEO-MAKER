"""Registers every job kind with the queue."""
from __future__ import annotations

from .pipeline import tasks
from .queue import register


def register_all() -> None:
    register("analyze_project", tasks.analyze_project, on_final_failure=tasks.fail_project)
    register("render_clip", tasks.render_clip, on_final_failure=tasks.fail_clip)
    register("analyze_music", tasks.analyze_music)
