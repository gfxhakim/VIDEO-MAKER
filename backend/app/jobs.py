"""Registers every job kind with the queue."""
from __future__ import annotations

from .pipeline import tasks
from .publishing import service as publish_service
from .queue import register


def register_all() -> None:
    register("analyze_project", tasks.analyze_project, on_final_failure=tasks.fail_project)
    register("render_clip", tasks.render_clip)
    register("analyze_music", tasks.analyze_music)
    register("publish", publish_service.run_publish_job, on_final_failure=publish_service.fail_publish_job)
