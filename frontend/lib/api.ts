// Typed client for the FastAPI backend.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

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

export type Platform = "youtube" | "tiktok" | "instagram" | "facebook";
export type Account = {
  id: number;
  platform: Platform;
  display_name: string;
  external_id: string;
  avatar_url: string | null;
  enabled: boolean;
  daily_limit: number;
  min_interval_minutes: number;
  token_expires_at: string | null;
  connected: boolean;
  created_at: string;
};

export type ProviderInfo = {
  slug: "youtube" | "tiktok" | "meta";
  label: string;
  configured: boolean;
  env_keys: string[];
  redirect_uri: string;
  docs_url: string;
  platforms: Platform[];
};
export type PlatformsInfo = { dry_run: boolean; redirect_base: string; providers: ProviderInfo[] };

export type PublishJob = {
  id: number;
  clip_id: number;
  account_id: number;
  platform: Platform;
  account_name: string;
  clip_title: string;
  thumb_url: string | null;
  scheduled_at: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  attempts: number;
  remote_url: string | null;
  error: string | null;
  published_at: string | null;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const fetcher = <T,>(path: string) => request<T>(path);

export const api = {
  presets: () => request<Presets>("/api/presets"),
  health: () => request<Record<string, unknown>>("/api/health"),

  createFromLink: (body: { url?: string; path?: string; name?: string; settings: GenerationSettings }) =>
    request<Project>("/api/projects", json("POST", body)),
  createFromUpload: (file: File, settings: GenerationSettings, onProgress?: (pct: number) => void) =>
    new Promise<Project>((resolve, reject) => {
      // XHR so we can show upload progress for big files
      const fd = new FormData();
      fd.append("file", file);
      fd.append("settings", JSON.stringify(settings));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/api/projects/upload`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.((e.loaded / e.total) * 100);
      xhr.onload = () => {
        if (xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new ApiError(xhr.status, xhr.responseText));
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error"));
      xhr.send(fd);
    }),
  regenerate: (id: number, settings?: GenerationSettings) =>
    request<Project>(`/api/projects/${id}/generate`, json("POST", settings)),
  deleteProject: (id: number) => request(`/api/projects/${id}`, { method: "DELETE" }),

  updateClip: (id: number, body: Partial<Pick<Clip, "title" | "description" | "hashtags" | "review_status" | "hook">>) =>
    request<Clip>(`/api/clips/${id}`, json("PATCH", body)),
  rerenderClip: (id: number) => request<Clip>(`/api/clips/${id}/rerender`, json("POST")),
  clipDownloadUrl: (id: number) => `${API_URL}/api/clips/${id}/download`,

  uploadMusic: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return request<MusicTrack[]>("/api/music", { method: "POST", body: fd });
  },
  deleteMusic: (id: number) => request(`/api/music/${id}`, { method: "DELETE" }),

  oauthStartUrl: (slug: string) => `${API_URL}/api/oauth/${slug}/start`,
  addSandbox: (platform: Platform) => request<Account>(`/api/accounts/sandbox?platform=${platform}`, json("POST")),
  updateAccount: (id: number, body: Partial<Pick<Account, "enabled" | "daily_limit" | "min_interval_minutes" | "display_name">>) =>
    request<Account>(`/api/accounts/${id}`, json("PATCH", body)),
  deleteAccount: (id: number) => request(`/api/accounts/${id}`, { method: "DELETE" }),

  schedule: (body: {
    clip_ids: number[];
    account_ids: number[];
    start_at?: string | null;
    interval_minutes: number;
    account_offset_minutes: number;
    jitter_minutes: number;
    privacy: string;
    publish_now: boolean;
  }) => request<PublishJob[]>("/api/publish/schedule", json("POST", body)),
  updatePublishJob: (id: number, body: Partial<{ status: string; scheduled_at: string; title: string }>) =>
    request<PublishJob>(`/api/publish/jobs/${id}`, json("PATCH", body)),
};
