# AutoClip Studio frontend

Next.js 15 (App Router) + Tailwind v4 + shadcn-style components, dark mode only.

- `npm run dev`: dev server on :3000. `/api` and `/media` are forwarded to `API_ORIGIN` (default `http://localhost:8000`).
- `npm run build`: static export into `out/`. In production FastAPI serves those files on the same domain, so there is no CORS or API URL to set.

Pages: `/signin` (also first-run account setup), `/` (studio dashboard), `/project?id=`, `/library`, `/music`, `/settings`.
