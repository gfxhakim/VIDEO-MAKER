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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { credentials: "include", ...init });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = "/signin";
  }
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
      xhr.withCredentials = true;
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
