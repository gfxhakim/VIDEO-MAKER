// Chunked, parallel, resumable upload client for /api/uploads (backend/app/api/uploads.py).
//
// The file is cut into chunks (size chosen by the server). A few chunks travel at once,
// each as its own short request; a failed chunk is retried on its own with backoff, and a
// refresh or a dropped connection continues from the chunks the server already has.
import type { GenerationSettings, Project } from "@/lib/api";

export type UploadPhase =
  | "preparing" // reading the file's fingerprint, asking the server what it already has
  | "uploading"
  | "paused" // by the user
  | "waiting" // connection trouble: retries on its own
  | "uploaded" // every byte is on the server, waiting for "Generate"
  | "finishing" // creating the project
  | "done"
  | "error" // cannot continue without the user (wrong file type, storage full, signed out)
  | "canceled";

export type UploadState = {
  phase: UploadPhase;
  fileName: string;
  size: number;
  sent: number; // bytes on the server + bytes of chunks in flight
  speed: number; // bytes per second, smoothed over the last seconds
  eta: number | null; // seconds left; null while unknown
  resumedFrom: number; // bytes the server already had when this session started
  message: string | null; // detail for "waiting" and "error"
  autoStart: boolean; // "Generate" was pressed: the project starts as soon as the upload ends
  project: Project | null;
};

export type ServerUpload = {
  id: string;
  filename: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  received: number[];
  received_bytes: number;
  status: "uploading" | "completing" | "completed";
  project_id: number | null;
  created_at: string;
  expires_at: string;
};

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts"];

const MAX_PARALLEL = 4;
const START_PARALLEL = 2;
// How many chunks travel at once: as many as the link can finish in about 20 s. On a slow
// uplink that is ONE (parallel requests would only share the same bandwidth, and every
// interruption would throw away several half-sent chunks); fast links get up to four.
const TARGET_CHUNK_SECONDS = 20;
const CHUNK_TIMEOUT_MS = 240_000; // hard stop, under the proxy's 5 minute limit for a request body
const STALL_MS = 45_000; // a request that moved no bytes for this long is dropped and retried
const MAX_BACKOFF_MS = 30_000;
const SPEED_WINDOW_MS = 15_000;
const EMIT_EVERY_MS = 250;

type Flight = { xhr: XMLHttpRequest; loaded: number; moved: number; fail: () => void };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      keepalive,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, "Network error");
  }
  if (!res.ok) throw new HttpError(res.status, await detail(res));
  return res.json() as Promise<T>;
}

async function detail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/** Worth retrying by itself: no response at all, timeouts, rate limits, proxy and server hiccups. */
const transient = (status: number) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;

/** Same file => same string, even after a rename, a refresh or on another device.
 *  Size plus a hash of three 256 KB samples (start, middle, end): instant even for 5 GB. */
export async function fingerprint(file: File): Promise<string> {
  const sample = 256 * 1024;
  try {
    const mid = Math.max(0, Math.floor(file.size / 2) - sample / 2);
    const parts = await Promise.all(
      [file.slice(0, sample), file.slice(mid, mid + sample), file.slice(Math.max(0, file.size - sample))].map((b) => b.arrayBuffer()),
    );
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      all.set(new Uint8Array(p), at);
      at += p.byteLength;
    }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return `${file.size}-${Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // crypto.subtle only exists on https / localhost: fall back to name + size + date
    let h = 5381;
    for (const ch of file.name) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    return `${file.size}-${file.lastModified}-${h.toString(16)}`;
  }
}

export const listUnfinishedUploads = () => call<ServerUpload[]>("GET", "/api/uploads");
export const discardUpload = (id: string) => call<{ ok: boolean }>("DELETE", `/api/uploads/${id}`);

export class ResumableUpload {
  readonly file: File;
  private state: UploadState;
  private listeners = new Set<(s: UploadState) => void>();

  private id: string | null = null;
  private chunkSize = 0;
  private total = 0;
  private have: Uint8Array = new Uint8Array(0); // 1 = the server confirmed this chunk
  private haveCount = 0;
  private confirmed = 0; // bytes in confirmed chunks
  private cursor = 0; // every chunk before this index is confirmed or in flight
  private flying = new Map<number, Flight>();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  private parallel = START_PARALLEL;
  private failures = 0; // in a row, across chunks
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private samples: { t: number; bytes: number }[] = [];
  private lastEmit = 0;
  private settings: GenerationSettings | null = null;
  private pendingAction: (() => void) | null = null;
  private onOnline = () => {
    if (this.state.phase === "waiting") this.retryNow(); // do not wait out the backoff once the network is back
  };

  constructor(file: File) {
    this.file = file;
    this.state = {
      phase: "preparing", fileName: file.name, size: file.size, sent: 0, speed: 0, eta: null,
      resumedFrom: 0, message: null, autoStart: false, project: null,
    };
  }

  // ------------------------------------------------------------ public
  getState = () => this.state;

  subscribe = (fn: (s: UploadState) => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Starts (or resumes) right away. Safe to call once. */
  async start() {
    window.addEventListener("online", this.onOnline);
    this.watchdog = setInterval(() => this.dropStalled(), 5000);
    await this.prepare();
  }

  pause() {
    if (this.state.phase !== "uploading" && this.state.phase !== "waiting") return;
    this.clearRetry();
    this.abortFlying();
    this.set({ phase: "paused", speed: 0, eta: null, message: null });
  }

  resume() {
    if (this.state.phase !== "paused" && this.state.phase !== "waiting") return;
    this.retryNow();
  }

  /** "Generate" pressed. If bytes are still travelling, the project is created the moment they are all in. */
  finish(settings: GenerationSettings) {
    this.settings = settings;
    this.set({ autoStart: true });
    if (this.state.phase === "uploaded") void this.complete();
  }

  /** Take back a "Generate" that has not happened yet. */
  cancelFinish() {
    if (this.state.phase === "finishing" || this.state.phase === "done") return;
    this.settings = null;
    this.set({ autoStart: false });
  }

  /** Stops and frees the space on the server. */
  async cancel() {
    const id = this.id;
    this.teardown();
    this.set({ phase: "canceled", speed: 0, eta: null, message: null });
    if (id && !this.state.project) await call("DELETE", `/api/uploads/${id}`, undefined, true).catch(() => {});
  }

  /** Stops talking to the server but leaves the bytes there (page is going away). */
  dispose() {
    this.teardown();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ steps
  private async prepare() {
    try {
      const fp = await fingerprint(this.file);
      const up = await call<ServerUpload>("POST", "/api/uploads", { filename: this.file.name, size: this.file.size, fingerprint: fp });
      if (this.state.phase === "canceled") return void call("DELETE", `/api/uploads/${up.id}`).catch(() => {});
      this.adopt(up);
      this.set({ phase: "uploading", sent: this.confirmed, resumedFrom: this.confirmed, message: null });
      this.pump();
    } catch (e) {
      const err = e as HttpError;
      if (this.state.phase === "canceled") return;
      if (transient(err.status ?? 0)) {
        this.failures++;
        this.wait("Cannot reach the server.", () => void this.prepare());
      } else this.fail(err.status === 401 ? "You were signed out. Sign in and choose the same file to continue." : err.message);
    }
  }

  private adopt(up: ServerUpload) {
    this.id = up.id;
    this.chunkSize = up.chunk_size;
    this.total = up.total_chunks;
    this.have = new Uint8Array(this.total);
    for (const i of up.received) this.have[i] = 1;
    this.haveCount = up.received.length;
    this.confirmed = up.received_bytes;
    this.cursor = 0;
    this.samples = [];
  }

  private chunkBytes(i: number) {
    return Math.min(this.chunkSize, this.file.size - i * this.chunkSize);
  }

  private nextMissing(): number {
    while (this.cursor < this.total && (this.have[this.cursor] || this.flying.has(this.cursor))) this.cursor++;
    return this.cursor < this.total ? this.cursor : -1;
  }

  private pump() {
    if (this.state.phase !== "uploading") return;
    while (this.flying.size < this.parallel) {
      const i = this.nextMissing();
      if (i < 0) break;
      this.send(i);
    }
    if (this.flying.size === 0 && this.haveCount === this.total) {
      this.set({ phase: "uploaded", sent: this.file.size, speed: 0, eta: 0, message: null }, true);
      if (this.settings) void this.complete();
    }
  }

  private send(i: number) {
    const start = i * this.chunkSize;
    const xhr = new XMLHttpRequest();
    const slot: Flight = { xhr, loaded: 0, moved: Date.now(), fail: () => settle(false, 408, "") };
    this.flying.set(i, slot);
    xhr.open("PUT", `/api/uploads/${this.id}/chunks/${i}`);
    xhr.withCredentials = true;
    xhr.timeout = CHUNK_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      slot.loaded = e.loaded;
      slot.moved = Date.now();
      this.progress();
    };
    const settle = (ok: boolean, status: number, text: string) => {
      if (this.flying.get(i) !== slot) return; // aborted by pause / cancel
      this.flying.delete(i);
      if (ok) {
        this.have[i] = 1;
        this.haveCount++;
        this.confirmed += this.chunkBytes(i);
        this.failures = 0;
        this.tune();
        this.progress(true);
        this.pump();
      } else this.chunkFailed(i, status, text);
    };
    xhr.onload = () => settle(xhr.status === 200, xhr.status, xhr.responseText);
    xhr.onerror = () => settle(false, 0, "");
    xhr.ontimeout = slot.fail;
    xhr.send(this.file.slice(start, start + this.chunkBytes(i)));
  }

  private chunkFailed(i: number, status: number, text: string) {
    this.cursor = Math.min(this.cursor, i);
    if (this.state.phase !== "uploading" && this.state.phase !== "waiting") return;
    let msg = text;
    try {
      msg = JSON.parse(text).detail ?? text;
    } catch {}
    if (status === 401) return this.fail("You were signed out. Sign in and choose the same file to continue.");
    if (status === 404) return void this.restart(); // the server no longer has this upload (expired, cancelled elsewhere)
    if (status === 409) return void this.resync(); // finished from another tab
    if (!transient(status)) return this.fail(msg || `Upload failed (HTTP ${status})`);
    this.failures++;
    this.parallel = Math.max(1, Math.floor(this.parallel / 2)); // a struggling link gets fewer, faster-finishing requests
    this.wait(navigator.onLine === false ? "You are offline. The upload continues by itself when the connection is back." : "Connection problem.");
  }

  /** Stop starting new chunks, try again after a growing, jittered delay (1s, 2s, 4s ... 30s), forever. */
  private wait(message: string, action?: () => void) {
    if (["paused", "canceled", "error", "done"].includes(this.state.phase)) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, this.failures - 1));
    const delay = base * (0.5 + Math.random() / 2);
    this.clearRetry();
    this.pendingAction = action ?? null;
    this.set({ phase: "waiting", message, speed: 0, eta: null });
    this.retryTimer = setTimeout(() => this.retryNow(), delay);
  }

  private retryNow() {
    if (this.state.phase !== "waiting" && this.state.phase !== "paused") return;
    this.clearRetry();
    const action = this.pendingAction;
    this.pendingAction = null;
    if (action) return action();
    void this.resync();
  }

  /** Ask the server which chunks it really has (a chunk whose answer got lost may be there), then carry on. */
  private async resync() {
    if (!this.id) return void this.prepare();
    try {
      const up = await call<ServerUpload>("GET", `/api/uploads/${this.id}`);
      if (["canceled", "error", "done"].includes(this.state.phase)) return;
      if (up.status === "completed") {
        // finished from another tab: fetch that project instead of uploading again
        this.abortFlying();
        this.set({ phase: "uploaded", sent: up.size, autoStart: true });
        return void this.complete(true);
      }
      for (const i of up.received) this.have[i] = 1; // merge: what we saw confirmed stays confirmed
      this.haveCount = this.have.reduce((n, b) => n + b, 0);
      this.confirmed = 0;
      for (let i = 0; i < this.total; i++) if (this.have[i]) this.confirmed += this.chunkBytes(i);
      this.cursor = 0;
      this.set({ phase: "uploading", message: null });
      this.progress(true);
      this.pump();
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 404) return void this.restart();
      if (err.status === 401) return this.fail("You were signed out. Sign in and choose the same file to continue.");
      this.failures++;
      this.wait("Cannot reach the server.");
    }
  }

  private async restart() {
    this.abortFlying();
    this.id = null;
    this.set({ phase: "preparing", sent: 0, speed: 0, eta: null, message: null });
    await this.prepare();
  }

  private async complete(alreadyDone = false) {
    if (!this.id || (!this.settings && !alreadyDone) || this.state.phase === "finishing" || this.state.phase === "done") return;
    this.set({ phase: "finishing", message: null });
    try {
      const project = await call<Project>("POST", `/api/uploads/${this.id}/complete`, { settings: this.settings ?? undefined, start: true });
      this.teardown();
      this.set({ phase: "done", project });
    } catch (e) {
      const err = e as HttpError;
      if (transient(err.status ?? 0)) {
        // safe to repeat: the server answers a second "complete" with the same project
        this.failures++;
        this.set({ phase: "uploaded" });
        this.wait("Cannot reach the server.", () => {
          this.set({ phase: "uploaded" });
          void this.complete(alreadyDone);
        });
      } else if (err.status === 409) void this.resync();
      else this.fail(err.message);
    }
  }

  // ------------------------------------------------------------ bookkeeping
  /** More parallel requests on fast links, a single one on slow links, so every request stays short. */
  private tune() {
    const speed = this.measure();
    if (!speed) return;
    this.parallel = Math.max(1, Math.min(MAX_PARALLEL, Math.floor((speed * TARGET_CHUNK_SECONDS) / this.chunkSize)));
  }

  private measure(): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    const span = s[s.length - 1].t - s[0].t;
    return span < 2000 ? 0 : Math.max(0, ((s[s.length - 1].bytes - s[0].bytes) / span) * 1000);
  }

  private progress(force = false) {
    const now = Date.now();
    let sent = this.confirmed;
    for (const f of this.flying.values()) sent += f.loaded;
    sent = Math.min(sent, this.file.size);
    const last = this.samples[this.samples.length - 1];
    if (last && sent < last.bytes) this.samples = []; // a chunk was thrown away: start measuring afresh
    this.samples.push({ t: now, bytes: sent });
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift();
    if (!force && now - this.lastEmit < EMIT_EVERY_MS) return;
    const speed = this.measure();
    this.tune();
    this.set({ sent, speed, eta: speed > 0 ? Math.ceil((this.file.size - sent) / speed) : null }, true);
  }

  private dropStalled() {
    const now = Date.now();
    for (const f of [...this.flying.values()]) {
      if (now - f.moved < STALL_MS) continue;
      f.fail(); // counts as a failed chunk (retried with backoff) ...
      f.xhr.abort(); // ... and the dead request is closed
    }
  }

  private abortFlying() {
    const flying = [...this.flying.values()];
    this.flying.clear();
    for (const f of flying) f.xhr.abort();
    this.cursor = 0;
    this.samples = [];
    this.state = { ...this.state, sent: this.confirmed };
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private teardown() {
    this.clearRetry();
    this.pendingAction = null;
    this.abortFlying();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    window.removeEventListener("online", this.onOnline);
  }

  private fail(message: string) {
    this.teardown();
    this.set({ phase: "error", message, speed: 0, eta: null });
  }

  private set(patch: Partial<UploadState>, timed = false) {
    this.state = { ...this.state, ...patch };
    if (timed) this.lastEmit = Date.now();
    for (const fn of this.listeners) fn(this.state);
  }
}
