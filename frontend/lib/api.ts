// Typed client for the FastAPI backend. Same origin in production and in dev (via rewrites).
export const API_URL = "";

export type GenerationSettings = {
  clip_count: number;
  min_duration: number;
  max_duration: number;
  editing_style: string;
  caption_style: string;
  aspect_ratio: string;
  auto_emoji: boolean;
  hook_title: boolean;
  music_track_ids: number[];
  music_volume: number;
  ducking: boolean;
  match_drop_to_hook: boolean;
  language?: string | null;
  caption_position?: number | null;
};

export const DEFAULT_SETTINGS: GenerationSettings = {
  clip_count: 20,
  min_duration: 15,
  max_duration: 60,
  editing_style: "face_track_zoom",
  caption_style: "hormozi",
  aspect_ratio: "9:16",
  auto_emoji: true,
  hook_title: false,
  music_track_ids: [],
  music_volume: 0.18,
  ducking: true,
  match_drop_to_hook: true,
  language: null,
  caption_position: null,
};

export type EditingStyle = { key: string; name: string; description: string; layout: string; hook_card?: boolean };
export type CaptionStyle = {
  key: string;
  name: string;
  description: string;
  mode: "word" | "chunk" | "stack";
  font: string;
  weight: number;
  italic?: boolean;
  size: number;
  uppercase: boolean;
  primary: string;
  highlight: string;
  accent: string;
  accent_cycle?: string[];
  outline_color: string;
  outline: number;
  shadow: number;
  glow: number;
  emoji?: boolean;
  spacing?: number;
};
export type Presets = {
  editing_styles: EditingStyle[];
  caption_styles: CaptionStyle[];
  aspect_ratios: { key: string; width: number; height: number }[];
  clip_count: { min: number; max: number; default: number };
};

export type Project = {
  id: number;
  name: string;
  source_type: "upload" | "url" | "path";
  source: string;
  status: "draft" | "queued" | "processing" | "done" | "failed";
  stage: string;
  progress: number;
  error: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  settings: GenerationSettings;
  created_at: string;
  clip_count: number;
  ready_count: number;
  thumb_url: string | null;
};

/** Still being worked on by the server (so pages keep polling it). */
export const isLive = (p?: Pick<Project, "status"> | null) => p?.status === "queued" || p?.status === "processing";

export type Clip = {
  id: number;
  project_id: number;
  rank: number;
  start: number;
  end: number;
  duration: number;
  score: number;
  score_breakdown: Record<string, number | string>;
  transcript: string;
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
  status: "pending" | "rendering" | "ready" | "failed";
  review_status: "pending" | "approved" | "rejected";
  posted: Partial<Record<Platform, string>>;
  error: string | null;
  video_url: string | null;
  thumb_url: string | null;
  music_track_id: number | null;
};

export type MusicTrack = {
  id: number;
  name: string;
  duration: number | null;
  bpm: number | null;
  drop_time: number | null;
  analyzed: boolean;
  url: string;
};

export type Platform = "tiktok" | "instagram" | "youtube" | "facebook";
export type KitEntry = { label: string; title: string; caption: string; hashtags: string[] };
export type PublishKit = Record<Platform, KitEntry>;

export type User = { id: number; email: string; name: string };
export type AuthStatus = { needs_setup: boolean; signup_open: boolean; user: User | null };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Turns a failed response into one plain sentence (FastAPI sends {"detail": ...}; proxies send HTML). */
export async function errorMessage(res: Response): Promise<string> {
  let msg = "";
  try {
    const j = await res.clone().json();
    const d = j?.detail ?? j;
    if (typeof d === "string") msg = d;
    else if (Array.isArray(d) && typeof d[0]?.msg === "string") msg = d[0].msg; // validation errors
    else if (d) msg = JSON.stringify(d);
  } catch {}
  if (msg) return msg;
  if (res.status === 413) return "That file is larger than the server accepts.";
  if (res.status >= 500) return "The server had a problem. Try again in a moment.";
  return res.statusText || `Request failed (${res.status})`;
}

/** Fired on `window` when the server says the session is gone. A listener that can handle it without
 *  a page load (the upload provider, which would lose the picked file) calls preventDefault(). */
export const SIGNED_OUT_EVENT = "autoclip:signed-out";

function signedOut() {
  const handled = !window.dispatchEvent(new Event(SIGNED_OUT_EVENT, { cancelable: true }));
  if (!handled) window.location.href = "/signin";
}

async function request<T>(path: string, init?: RequestInit, quiet = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
  }
  if (res.status === 401 && !quiet && typeof window !== "undefined" && !path.startsWith("/api/auth")) signedOut();
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const fetcher = <T,>(path: string) => request<T>(path);
/** Same, but a lost session only makes it fail: for requests sent before the session check has answered. */
export const quietFetcher = <T,>(path: string) => request<T>(path, undefined, true);

export const api = {
  presets: () => request<Presets>("/api/presets"),
  health: () => request<Record<string, unknown>>("/api/health"),

  createFromLink: (body: { url?: string; path?: string; name?: string; settings: GenerationSettings }) =>
    request<Project>("/api/projects", json("POST", body)),
  regenerate: (id: number, settings?: GenerationSettings) =>
    request<Project>(`/api/projects/${id}/generate`, json("POST", settings)),
  deleteProject: (id: number) => request(`/api/projects/${id}`, { method: "DELETE" }),

  updateClip: (id: number, body: Partial<Pick<Clip, "title" | "description" | "hashtags" | "review_status" | "hook">>) =>
    request<Clip>(`/api/clips/${id}`, json("PATCH", body)),
  rerenderClip: (id: number) => request<Clip>(`/api/clips/${id}/rerender`, json("POST")),
  clipDownloadUrl: (id: number) => `${API_URL}/api/clips/${id}/download`,

  /** `onProgress` gets 0..100 while the files travel (XHR, because fetch cannot report upload progress). */
  uploadMusic: (files: File[], onProgress?: (pct: number) => void) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    if (!onProgress) return request<MusicTrack[]>("/api/music", { method: "POST", body: fd });
    return new Promise<MusicTrack[]>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/api/music`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.min(100, (e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status === 401) signedOut();
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(body)) return resolve(body as MusicTrack[]);
        const detail = (body as { detail?: unknown } | null)?.detail;
        reject(new ApiError(xhr.status, typeof detail === "string" ? detail : xhr.status === 413 ? "That file is larger than the server accepts." : `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, "Connection problem during the upload. Check your internet and try again."));
      xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
      xhr.send(fd);
    });
  },
  deleteMusic: (id: number) => request(`/api/music/${id}`, { method: "DELETE" }),

  kit: (id: number) => request<PublishKit>(`/api/clips/${id}/kit`),
  markPosted: (id: number, platform: Platform, posted: boolean) =>
    request<Clip>(`/api/clips/${id}/posted`, json("POST", { platform, posted })),
  exportZipUrl: (projectId: number, scope: "approved" | "all") => `${API_URL}/api/projects/${projectId}/export.zip?scope=${scope}`,

  authStatus: () => request<AuthStatus>("/api/auth/status"),
  signin: (email: string, password: string) => request<User>("/api/auth/signin", json("POST", { email, password })),
  signup: (email: string, password: string, name: string) => request<User>("/api/auth/signup", json("POST", { email, password, name })),
  signout: () => request("/api/auth/signout", json("POST")),
  changePassword: (current_password: string, new_password: string) =>
    request("/api/auth/password", json("POST", { current_password, new_password })),
};
