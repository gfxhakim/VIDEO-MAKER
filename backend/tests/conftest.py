import os
import sys
import tempfile
from pathlib import Path

# isolated data dir + no network for every test run
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="autoclip-test-"))
os.environ.setdefault("TRANSCRIBE_BACKEND", "none")
os.environ.setdefault("EMBEDDED_WORKER", "false")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
