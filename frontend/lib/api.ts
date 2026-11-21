// Typed client for the FastAPI backend. Same origin in production and in dev (via rewrites).
export const API_URL = "";

export type HookCardStyle = "light" | "dark" | "accent" | "glass" | "viral_yellow" | "breaking_red";
export type WatermarkPosition = "top_left" | "top_right" | "bottom_left" | "bottom_right";

export type GenerationSettings = {
  clip_count: number;
  min_duration: number;
  max_duration: number;
  editing_style: string;
  caption_style: string;
  aspect_ratio: string;
  video_effect?: string;
  playback_speed?: number;
  auto_emoji: boolean;
  hook_title: boolean;
  hook_card_style?: HookCardStyle;
  hook_card_duration?: number;
  music_track_ids: number[];
  music_volume: number;
  ducking: boolean;
  match_drop_to_hook: boolean;
  beat_sync_zoom?: boolean;
  normalize_audio?: boolean;
  denoise_audio?: boolean;
  remove_silences?: boolean;
  progress_bar?: boolean;
  watermark_text?: string;
  watermark_position?: WatermarkPosition;
  broll_id?: number | null;
  use_ai?: boolean;
  language?: string | null;
  caption_position?: number | null;
  caption_color?: string | null;
};

export const DEFAULT_SETTINGS: GenerationSettings = {
  clip_count: 20,
  min_duration: 15,
  max_duration: 60,
  editing_style: "face_track_zoom",
  caption_style: "hormozi",
  aspect_ratio: "9:16",
  video_effect: "none",
  playback_speed: 1.0,
  auto_emoji: true,
  hook_title: false,
  hook_card_style: "light",
  hook_card_duration: 0,
  music_track_ids: [],
  music_volume: 0.18,
  ducking: true,
  match_drop_to_hook: true,
  beat_sync_zoom: false,
  normalize_audio: true,
  denoise_audio: false,
  remove_silences: false,
  progress_bar: false,
  watermark_text: "",
  watermark_position: "bottom_right",
  broll_id: null,
  use_ai: false,
  language: null,
  caption_position: null,
  caption_color: null,
};

export type EditingStyle = { key: string; name: string; description: string; layout: string; hook_card?: boolean };
export type VideoEffect = {
  key: string;
  name: string;
  category: string;
  badge?: string;
  description: string;
  preview_filter?: string;
  preview_tint?: string;
};
export type CaptionStyle = {
  key: string;
  name: string;
  description: string;
  mode: "word" | "chunk" | "stack" | "boxed";
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
  box_color?: string;
  outline: number;
  shadow: number;
  glow: number;
  emoji?: boolean;
  spacing?: number;
};
export type Presets = {
  editing_styles: EditingStyle[];
  caption_styles: CaptionStyle[];
  video_effects?: VideoEffect[];
  playback_speeds?: { value: number; label: string }[];
  aspect_ratios: { key: string; width: number; height: number }[];
  hook_card_styles?: { key: HookCardStyle; name: string }[];
  caption_colors?: { key: string; name: string }[];
  clip_count: { min: number; max: number; default: number };
  llm_configured?: boolean;
};

export type Project = {
  id: number;
  name: string;
  source_type: "upload" | "url" | "path";
  source: string;
  source_start?: number | null;
  source_end?: number | null;
  source_deleted?: boolean;
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

export type WordToken = { word: string; start: number; end: number; p?: number };

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
  overrides?: Partial<GenerationSettings>;
  has_words_override?: boolean;
};

export type MusicTrack = {
  id: number;
  name: string;
  duration: number | null;
  bpm: number | null;
  drop_time: number | null;
  beats?: number[];
  analyzed: boolean;
  url: string;
};

export type BrollClip = {
  id: number;
  name: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  url: string;
};

export type URLProbeResult = {
  title: string;
  duration: number | null;
  thumbnail: string | null;
  uploader: string | null;
  webpage_url: string;
};

export type TranscriptResponse = {
  language: string;
  sentences: { start: number; end: number; text: string }[];
  words: WordToken[];
};

export type StorageOverview = {
  disk: { total: number; used: number; free: number };
  music_bytes: number;
  broll_bytes: number;
  uploads_bytes: number;
  models_bytes: number;
  projects: {
    id: number;
    name: string;
    status: string;
    source_deleted: boolean;
    source_bytes: number;
    clips_bytes: number;
    total_bytes: number;
  }[];
};

export type RuntimeSettings = {
  default_watermark_text: string;
  default_watermark_position: WatermarkPosition;
  llm_base_url: string;
  llm_model: string;
  llm_has_key: boolean;
  llm_configured: boolean;
};

export type JobItem = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type Platform = "tiktok" | "instagram" | "youtube" | "facebook";
export type KitEntry = { label: string; title: string; caption: string; hashtags: string[] };
export type PublishKit = Record<Platform, KitEntry>;

export type User = {
  id: number;
  email: string;
  name: string;
  role?: "admin" | "user";
  is_active?: boolean;
  created_at?: string;
  last_login_at?: string | null;
  last_seen_at?: string | null;
};
export type AuthStatus = { needs_setup: boolean; signup_open: boolean; user: User | null };

export type AdminOverview = {
  users: { total: number; active: number; suspended: number; admins: number; online_now: number };
  projects: { total: number; processing: number; queued: number; done: number; failed: number };
  clips: { total: number; ready: number; approved: number };
  jobs: { queued: number; running: number; failed: number };
  activity_24h: number;
  storage: { disk_total: number; disk_used: number; disk_free: number; data_dir_bytes: number };
  signup_open: boolean;
  ytdlp_cookies_configured: boolean;
};

export type AdminSettings = {
  allow_signup: boolean;
  ytdlp_cookies_configured: boolean;
  ytdlp_cookies_source: "env_file" | "saved" | null;
  ytdlp_cookies_updated_at: string | null;
};

export type AdminUserRow = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "user";
  is_active: boolean;
  online: boolean;
  created_at: string;
  last_login_at: string | null;
  last_seen_at: string | null;
  last_ip: string;
  project_count: number;
  clip_count: number;
  music_count: number;
  broll_count: number;
  storage_bytes: number;
  activity_count: number;
  last_action: { action: string; detail: string; target_type: string; target_id: number | null; created_at: string } | null;
};

export type AdminActivityItem = {
  id: number;
  user_id: number | null;
  user_email: string;
  user_name: string;
  user_role: string | null;
  action: string;
  target_type: string;
  target_id: number | null;
  detail: string;
  ip: string;
  user_agent: string;
  created_at: string;
};

export type AdminActivityResponse = { items: AdminActivityItem[]; total: number; actions: string[] };

export type AdminProjectRow = {
  id: number;
  name: string;
  owner: { id: number; email: string; name: string } | null;
  source_type: string;
  source: string;
  status: string;
  stage: string;
  progress: number;
  duration: number | null;
  clip_count: number;
  ready_count: number;
  storage_bytes: number;
  created_at: string;
  updated_at: string;
};

export type AdminJobRow = {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  project_id: number | null;
  project_name: string | null;
  owner_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function errorMessage(res: Response): Promise<string> {
  let msg = "";
  try {
    const j = await res.clone().json();
    const d = j?.detail ?? j;
    if (typeof d === "string") msg = d;
    else if (Array.isArray(d) && typeof d[0]?.msg === "string") msg = d[0].msg;
    else if (d) msg = JSON.stringify(d);
  } catch {}
  if (msg) return msg;
  if (res.status === 413) return "That file is larger than the server accepts.";
  if (res.status >= 500) return "The server had a problem. Try again in a moment.";
  return res.statusText || `Request failed (${res.status})`;
}

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
export const quietFetcher = <T,>(path: string) => request<T>(path, undefined, true);

function xhrUpload<T>(path: string, files: File[], onProgress?: (pct: number) => void): Promise<T> {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  if (!onProgress) return request<T>(path, { method: "POST", body: fd });
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
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
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
      const detail = (body as { detail?: unknown } | null)?.detail;
      reject(new ApiError(xhr.status, typeof detail === "string" ? detail : xhr.status === 413 ? "That file is larger than the server accepts." : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "Connection problem during the upload. Check your internet and try again."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
    xhr.send(fd);
  });
}

export const api = {
  presets: () => request<Presets>("/api/presets"),
  health: () => request<Record<string, unknown>>("/api/health"),

  probeUrl: (url: string) => request<URLProbeResult>("/api/projects/probe-url", json("POST", { url })),
  createFromLink: (body: { url?: string; path?: string; name?: string; source_start?: number | null; source_end?: number | null; settings: GenerationSettings }) =>
    request<Project>("/api/projects", json("POST", body)),
  regenerate: (id: number, settings?: GenerationSettings, mode: "rescore" | "restyle" = "rescore") =>
    request<Project>(`/api/projects/${id}/generate`, json("POST", { settings, mode })),
  pruneSource: (id: number) => request<{ ok: boolean; freed_bytes: number }>(`/api/projects/${id}/prune-source`, json("POST")),
  deleteProject: (id: number) => request(`/api/projects/${id}`, { method: "DELETE" }),
  transcript: (id: number) => request<TranscriptResponse>(`/api/projects/${id}/transcript`),
  createManualClip: (id: number, body: { start: number; end: number; title?: string; hook?: string; snap_speech?: boolean }) =>
    request<Clip>(`/api/projects/${id}/clips`, json("POST", body)),

  updateClip: (
    id: number,
    body: Partial<Pick<Clip, "title" | "description" | "hashtags" | "review_status" | "hook" | "start" | "end" | "music_track_id">> & {
      overrides?: Record<string, unknown>;
      clear_music?: boolean;
      words_override?: WordToken[] | null;
    },
  ) => request<Clip>(`/api/clips/${id}`, json("PATCH", body)),
  deleteClip: (id: number) => request(`/api/clips/${id}`, { method: "DELETE" }),
  bulkClips: (
    clip_ids: number[],
    action: "approve" | "reject" | "pending" | "delete" | "rerender" | "apply",
    extra?: { overrides?: Record<string, unknown>; music_track_id?: number | null; clear_music?: boolean; rerender?: boolean },
  ) => request<{ ok: boolean; count: number }>("/api/clips/bulk", json("POST", { clip_ids, action, ...extra })),
  getClipWords: (id: number) => request<{ words: WordToken[]; is_override: boolean }>(`/api/clips/${id}/words`),
  rerenderClip: (id: number) => request<Clip>(`/api/clips/${id}/rerender`, json("POST")),
  aiRewriteClip: (id: number) => request<Clip>(`/api/clips/${id}/ai-copy`, json("POST")),
  captureThumbnail: (id: number, at: number) => request<Clip>(`/api/clips/${id}/thumbnail`, json("POST", { at })),
  clipDownloadUrl: (id: number) => `${API_URL}/api/clips/${id}/download`,
  thumbnailDownloadUrl: (id: number) => `${API_URL}/api/clips/${id}/thumbnail`,
  subtitleDownloadUrl: (id: number, fmt: "srt" | "vtt") => `${API_URL}/api/clips/${id}/subtitles/${fmt}`,

  uploadMusic: (files: File[], onProgress?: (pct: number) => void) => xhrUpload<MusicTrack[]>("/api/music", files, onProgress),
  updateMusic: (id: number, body: { name?: string; drop_time?: number }) => request<MusicTrack>(`/api/music/${id}`, json("PATCH", body)),
  reanalyzeMusic: (id: number) => request<MusicTrack>(`/api/music/${id}/reanalyze`, json("POST")),
  deleteMusic: (id: number) => request(`/api/music/${id}`, { method: "DELETE" }),

  uploadBroll: (files: File[], onProgress?: (pct: number) => void) => xhrUpload<BrollClip[]>("/api/broll", files, onProgress),
  deleteBroll: (id: number) => request(`/api/broll/${id}`, { method: "DELETE" }),

  kit: (id: number) => request<PublishKit>(`/api/clips/${id}/kit`),
  markPosted: (id: number, platform: Platform, posted: boolean) =>
    request<Clip>(`/api/clips/${id}/posted`, json("POST", { platform, posted })),
  exportZipUrl: (projectId: number, scope: "approved" | "all", subtitles = true) =>
    `${API_URL}/api/projects/${projectId}/export.zip?scope=${scope}&subtitles=${subtitles}`,

  storage: () => request<StorageOverview>("/api/system/storage"),
  runtimeSettings: () => request<RuntimeSettings>("/api/settings"),
  updateRuntimeSettings: (body: Partial<{
    default_watermark_text: string;
    default_watermark_position: WatermarkPosition;
    llm_base_url: string;
    llm_api_key: string;
    llm_model: string;
  }>) => request<RuntimeSettings>("/api/settings", json("PUT", body)),
  testLlm: () => request<{ ok: boolean }>("/api/settings/test-llm", json("POST")),
  jobs: (limit = 50) => request<JobItem[]>(`/api/jobs?limit=${limit}`),
  retryJob: (id: number) => request<JobItem>(`/api/jobs/${id}/retry`, json("POST")),
  cancelJob: (id: number) => request<JobItem>(`/api/jobs/${id}/cancel`, json("POST")),

  authStatus: () => request<AuthStatus>("/api/auth/status"),
  signin: (email: string, password: string) => request<User>("/api/auth/signin", json("POST", { email, password })),
  signup: (email: string, password: string, name: string) => request<User>("/api/auth/signup", json("POST", { email, password, name })),
  signout: () => request("/api/auth/signout", json("POST")),
  changePassword: (current_password: string, new_password: string) =>
    request("/api/auth/password", json("POST", { current_password, new_password })),

  adminOverview: () => request<AdminOverview>("/api/admin/overview"),
  adminUsers: (q = "") => request<AdminUserRow[]>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  adminCreateUser: (body: { email: string; name: string; password: string; role: "user" | "admin" }) =>
    request<AdminUserRow>("/api/admin/users", json("POST", body)),
  adminUpdateUser: (id: number, body: { name?: string; role?: "user" | "admin"; is_active?: boolean; new_password?: string }) =>
    request<AdminUserRow>(`/api/admin/users/${id}`, json("PATCH", body)),
  adminDeleteUser: (id: number) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminActivity: (params?: { user_id?: number; action?: string; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (params?.user_id !== undefined) p.set("user_id", String(params.user_id));
    if (params?.action) p.set("action", params.action);
    if (params?.q) p.set("q", params.q);
    if (params?.limit !== undefined) p.set("limit", String(params.limit));
    if (params?.offset !== undefined) p.set("offset", String(params.offset));
    const qs = p.toString();
    return request<AdminActivityResponse>(`/api/admin/activity${qs ? `?${qs}` : ""}`);
  },
  adminProjects: (params?: { user_id?: number; status?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (params?.user_id !== undefined) p.set("user_id", String(params.user_id));
    if (params?.status) p.set("status", params.status);
    if (params?.limit !== undefined) p.set("limit", String(params.limit));
    const qs = p.toString();
    return request<AdminProjectRow[]>(`/api/admin/projects${qs ? `?${qs}` : ""}`);
  },
  adminDeleteProject: (id: number) => request<{ ok: boolean }>(`/api/admin/projects/${id}`, { method: "DELETE" }),
  adminJobs: (limit = 60) => request<AdminJobRow[]>(`/api/admin/jobs?limit=${limit}`),
  adminSettings: () => request<AdminSettings>("/api/admin/settings"),
  adminUpdateSettings: (body: { allow_signup?: boolean; ytdlp_cookies?: string }) =>
    request<AdminSettings>("/api/admin/settings", json("PUT", body)),
};
