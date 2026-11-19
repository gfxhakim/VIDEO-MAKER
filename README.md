# AutoClip Studio

Self-hosted app that turns long videos (streams, podcasts, campaigns) into **1 to 50 vertical / square / wide clips**
with smart reframing, kinetic word-by-word captions with Apple iOS emojis, and background music synced to the beat with ducking.

- **No API keys required.** Transcription runs locally with faster-whisper, face tracking runs locally with OpenCV YuNet/Haar, and nothing is sent to third parties (optional local Ollama / OpenAI-compatible AI copy & scoring can be enabled in Settings).
- **You post by hand.** Every clip comes with a ready-to-copy caption, title, hashtags, and `.SRT` subtitles for TikTok, Instagram Reels,
  YouTube Shorts and Facebook, plus one-click downloads (or a ZIP of every approved clip). See [docs/PUBLISHING.md](docs/PUBLISHING.md).
- **Private by default.** A sign-in page protects the dashboard and every video file. The first person to open the app creates the owner account.

```
frontend/   Next.js + Tailwind + shadcn/ui dashboard (dark mode), exported as static files
backend/    FastAPI API + job worker + FFmpeg / Whisper / YuNet / yt-dlp pipeline; also serves the frontend
Dockerfile  one image with both, used by Railway
```

## Deploy on Railway

1. Push this repository to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it. Railway finds the `Dockerfile` and `railway.json` on its own.
3. Open the service, go to **Settings → Volumes → Add Volume**, and mount it at **`/data`**.
   Projects, clips, music, B-roll, the database, the Whisper model and the session key all live there, so they survive redeploys.
   Without a volume, everything is wiped on every deploy.
4. Under **Settings → Networking**, click **Generate Domain**.
5. Open the domain. You land on the sign-in page; the first visit asks you to create the owner account. Then you go straight to the dashboard.

Optional variables (**Variables** tab):

| Variable | Default | What it does |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny` is fastest, `small` is more accurate but needs more RAM and CPU. |
| `WORKER_CONCURRENCY` | `0` (auto) | Clips rendered at the same time. Auto picks 1 below 4 vCPUs or 4 GB RAM, up to 3 on bigger plans. |
| `FFMPEG_PRESET` | `veryfast` | `medium` gives smaller files at the same quality but renders slower. |
| `FFMPEG_CRF` | `21` | Quality. Lower is sharper and bigger; `18` makes files about a third larger. |
| `CPU_LIMIT` | auto | Set it to your plan's vCPU count if `/api/health` reports more `cpus` than you pay for. |
| `ALLOW_SIGNUP` | `false` | Set `true` to let more people create their own accounts. |
| `APP_SECRET_KEY` | auto | Session signing key. Generated into `/data/secret.key` if you leave it empty. |
| `LLM_BASE_URL` | empty | Optional Ollama / OpenAI-compatible URL for AI hook copy & moment boosting. |

Sizing: the `base` Whisper model and FFmpeg run comfortably with **2 GB RAM**. The first transcription downloads the
model (~140 MB) into the volume once. Uploads are the most reliable source on a cloud server; some sites block
downloads from datacenter IPs, so a pasted link can fail where an upload works.

## Run locally

Requirements: **Python 3.11+**, **Node 20+**, **FFmpeg** on your PATH (`ffmpeg -version`).

```bash
# 1) backend
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/download_fonts.py                       # caption fonts (one time)
python scripts/download_models.py                      # YuNet face detector (one time)
cp .env.example .env
uvicorn app.main:app --port 8000

# 2) frontend (new terminal)
cd frontend
cp .env.example .env.local                             # API_ORIGIN=http://localhost:8000
npm install && npm run dev
```

Open http://localhost:3000. The dev server forwards `/api` and `/media` to the backend, so cookies work the same way as in production.

Or run the production image locally: `docker build -t autoclip . && docker run -p 8000:8000 -v autoclip-data:/data autoclip`, then open http://localhost:8000.

## How it works

1. **Ingest**: resumable chunked upload, a path on the server, or a URL via `yt-dlp` (with pre-flight link check and optional start/end range).
2. **Transcribe**: local faster-whisper with word-level timestamps and language selection. Cached per project, so re-styling never re-transcribes.
3. **Score moments**: the transcript is split into sentences, and every window that starts and ends on a sentence boundary
   (5–180s) is scored on hook strength of the first line, speech pace, loudness, loudness spikes
   (laughs, shouts), emotional words, dead air (penalty), visual cuts and whether it ends on a full sentence (`backend/app/pipeline/highlights.py`).
4. **Reframe (`9:16`, `4:5`, `1:1`, `16:9`)**: OpenCV YuNet face detection (with Haar fallback), scene-cut-aware smoothing, and punch-in zooms (optionally synced to music beats). Layouts: face tracking with punch-in zooms, locked talking head,
   podcast split-screen, gameplay + facecam, speaker + looping B-roll split, blurred fill with hook title, center crop.
5. **Trending Effects, Speed, Captions & Polish**: choose from 10 curated clipper video effects (`backend/app/presets/video_effects.json` — HDR Crisp, Hook Flash, RGB Glitch Burst, Blur Reveal, Impact Shake, Dark Podcast Studio, Warm Halation Bloom, 35mm Grain, VHS Retro, B&W Noir) plus `0.9x–1.25x` clip pacing before or after generating. ASS subtitles feature pixel-accurate wrapping, active-word highlight, bounce, keyword colors, neon glow, boxed pill, stacked lead line + keyword, Apple iOS auto-emojis (`backend/assets/emoji/`), themed hook cards, silence jump-cutting, retention progress bar, watermark handle, `-14 LUFS` loudness normalization, and noise cleanup.
6. **Music & B-Roll**: upload songs (auto BPM, beat grid, and drop detection with manual drop override) and looping B-roll videos; sidechain ducking lowers music under speech.
7. **Edit, batch-style, review & post**: after generating, customize per-clip video effects, speed, music track/volume, audio polish, captions, trim timestamps (with Snap to speech end), fix burned-in transcript words, batch-apply FX/music across selected clips, create manual clips from the transcript, pick custom cover frames, export `.MP4` + captions + `.SRT` ZIP, and free raw source video storage when done.

Each step is a durable job in a SQLite-backed queue with retries and backoff. Each clip renders as its own job,
so one bad clip never sinks a run, and interrupted jobs resume after a restart.

## Styles are config, not code

- `backend/app/presets/editing_styles.json`: layout, zoom, smoothing, caption position, hook card.
- `backend/app/presets/caption_styles.json`: font, size, colors, stroke, glow, bounce, words per phrase, mode.
- `backend/app/presets/video_effects.json`: trending color grades, hook flashes, RGB glitch, blur reveal & shake FX.
- `backend/app/presets/emoji_map.json`: spoken keyword → iOS emoji (`python scripts/download_emojis.py` refreshes Apple artwork).

## Tests

```bash
cd backend && python -m pytest -q        # API, unit tests and FFmpeg render integration tests
cd frontend && npx tsc --noEmit && npm run lint && npm run build
```

## Content rules

Only process and post videos and music you own or are licensed to use.
