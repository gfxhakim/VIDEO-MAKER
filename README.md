# AutoClip Studio

Self-hosted app that turns long videos (streams, podcasts, campaigns) into **10 to 50 vertical 9:16 clips**
with smart reframing, kinetic word-by-word captions, background music with ducking, and an
**Auto-Publish Hub** that schedules posts to unlimited TikTok, YouTube Shorts, Instagram Reels and Facebook accounts.

```
frontend/   Next.js + Tailwind + shadcn/ui dashboard (dark mode)
backend/    FastAPI API + job worker + FFmpeg/Whisper/yt-dlp pipeline + publishing
docs/       Publishing setup, architecture notes
```

## Quick start

Requirements: **Python 3.11+**, **Node 20+**, **FFmpeg** on your PATH (`ffmpeg -version`).

```bash
# 1) backend
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/download_fonts.py                       # caption fonts (one time)
cp .env.example .env                                   # then edit APP_SECRET_KEY
uvicorn app.main:app --port 8000

# 2) frontend (new terminal)
cd frontend
cp .env.example .env.local
npm install && npm run dev
```

Open http://localhost:3000, drop in a video (or paste a YouTube URL / local path), choose the number of clips,
pick an editing style and caption style, and press **Generate**.

The first transcription downloads the Whisper model (`base`, ~140 MB) once.

### Keep your laptop light

| Setting (`backend/.env`) | Effect |
|---|---|
| `TRANSCRIBE_BACKEND=groq` + `GROQ_API_KEY` | Transcription runs in the cloud on Groq's free tier; nothing heavy runs locally. |
| `TRANSCRIBE_BACKEND=openai` + `OPENAI_API_KEY` | Same, with OpenAI `whisper-1`. |
| `WHISPER_MODEL=tiny` | Fastest local model on weak CPUs (`base` is the default, `small` is more accurate). |
| `WORKER_CONCURRENCY=1` | Render one clip at a time (default). Raise it on a strong machine. |
| `FFMPEG_PRESET=veryfast` | Encoding speed. `medium` gives smaller files at the same quality. |
| `EMBEDDED_WORKER=false` | Run renders in a separate process: `python -m app.worker`. |

## How it works

1. **Ingest** – upload, local path, or URL via `yt-dlp` (best ≤1080p).
2. **Transcribe** – Whisper with word-level timestamps (faster-whisper locally, or OpenAI/Groq API). Cached per project, so re-styling never re-transcribes.
3. **Score moments** – the transcript is split into sentences, and every window that starts and ends on a sentence boundary
   (within your min/max length) is scored on: hook strength of the first line, speech pace, loudness vs. the rest of the video,
   loudness spikes (laughs/shouts), emotional vocabulary, dead air (penalty), visual cuts per second and whether it ends on a
   full sentence. The best non-overlapping windows win (`backend/app/pipeline/highlights.py`).
4. **Reframe 16:9 → 9:16** – OpenCV face detection at 4 fps, gap filling + median filter + a "virtual camera" with dead-zone
   and easing, turned into an FFmpeg crop expression. Crops come straight from the full-res source and are scaled once
   with Lanczos (no stretching, no double scaling). Layouts: face tracking with punch-in zooms, locked talking head,
   podcast split-screen (two speakers stacked), gameplay + facecam, blurred fill with hook title, center crop.
5. **Captions** – ASS subtitles generated from word timestamps: active-word highlight, bounce, keyword accent colors,
   neon glow, stacked lead-line + keyword, plus auto-emoji (Twemoji PNGs) keyed off the spoken words.
6. **Music** – upload several songs; each is analyzed (tempo, beat grid, the drop). Songs rotate across clips, the drop
   lands on the clip's hook moment, and a sidechain compressor ducks the music whenever someone speaks.
7. **Render** – one FFmpeg pass per clip: H.264 CRF 18, AAC 192k, `+faststart`, 1080×1920.
8. **Review & publish** – approve/reject, edit titles/tags/hook, then publish now or schedule with staggered intervals.

Each step is a durable job in a SQLite-backed queue with retries and exponential backoff; each clip renders as its own
job, so one bad clip never sinks a run, and interrupted jobs resume after a restart.

## Styles are config, not code

- `backend/app/presets/editing_styles.json` – layout, zoom amount, smoothing, caption position, hook card…
- `backend/app/presets/caption_styles.json` – font, size, colors, stroke, glow, bounce, words per phrase, mode.
- `backend/app/presets/emoji_map.json` – spoken keyword → emoji.

Add a block to the JSON and it appears in the style picker. The built-in presets were tuned against the reference reels
(white hook-title card over a blurred frame, single-word condensed pop with green/purple accents, neon serif glow,
gaming stack with a giant italic keyword, wide-tracked cinematic single word).

## Publishing

See **[docs/PUBLISHING.md](docs/PUBLISHING.md)** for creating the YouTube, TikTok and Meta developer apps.
Set `PUBLISH_DRY_RUN=true` to try the whole scheduler with sandbox accounts before connecting real ones.

## Tests

```bash
cd backend && python -m pytest -q        # unit tests + an FFmpeg render test (skipped without ffmpeg)
cd frontend && npm run lint && npm run build
```

## Content & platform rules

Only process and publish videos and music you own or are licensed to use. The scheduler spaces posts out per account and
per platform, but each platform's own terms (and API quotas) still apply to you; TikTok forces private visibility until
your developer app passes its audit.
