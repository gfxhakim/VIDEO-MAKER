"""Standalone worker process:  python -m app.worker

Runs transcription/render jobs. Use this when EMBEDDED_WORKER=false
(so restarting the API never interrupts a long render).
"""
from __future__ import annotations

import logging

from .db import init_db
from .jobs import register_all
from .queue import Worker


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    register_all()
    Worker().run_forever()


if __name__ == "__main__":
    main()
