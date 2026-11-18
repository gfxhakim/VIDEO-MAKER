"""Standalone worker process:  python -m app.worker

Runs render jobs and the publish scheduler. Use this when EMBEDDED_WORKER=false
(recommended for long renders, so restarting the API never interrupts them).
"""
from __future__ import annotations

import logging

from .db import init_db
from .jobs import register_all
from .publishing.scheduler import Scheduler
from .queue import Worker


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    register_all()
    Scheduler().start()
    Worker().run_forever()


if __name__ == "__main__":
    main()
