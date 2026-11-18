// Chunked, resumable upload client for /api/uploads (backend/app/api/uploads.py).
//
// The file is cut into chunks (size chosen by the server). Each chunk is its own short
// request; a failed chunk is retried on its own with backoff, and a refresh, a closed tab or
// a dropped connection continues from the chunks the server already has. Chunks are written
// by position on the server, so sending one twice is harmless and none can be lost: the
// upload only counts as complete when the server lists every chunk.
import type { GenerationSettings, Project } from "@/lib/api";

export type UploadPhase =
  | "preparing" // reading the file's fingerprint, asking the server what it already has
  | "uploading"
  | "paused" // by the user
  | "waiting" // connection trouble: retries on its own
  | "uploaded" // every byte is on the server, waiting for "Generate"
  | "finishing" // creating the project
  | "done"
  | "error" // cannot continue without the user
  | "canceled";

export type UploadErrorCode =
  | "signed-out" // 401: the session ended
  | "not-video" // 400: the server does not take this file type
  | "too-large" // 413
  | "server-full" // 507: no room on the data volume
  | "file-gone" // the browser can no longer read the file (moved, renamed, changed, cloud file offline)
  | "different-file" // "continue" was asked for, but this is not the file that was being uploaded
  | "too-slow" // chunks cannot get through before the proxy cuts them off
  | "server"; // anything else the server refused

export type UploadState = {
  id: string | null; // the server's id for this upload, once known
  phase: UploadPhase;
  fileName: string;
  size: number;
  sent: number; // bytes the server confirmed + bytes of chunks in flight (drives the bar)
  safe: number; // bytes the server confirmed: these survive a refresh or a lost connection
  speed: number; // bytes per second, smoothed; 0 while unknown
  eta: number | null; // seconds left; null while unknown
  resumedFrom: number; // bytes the server already had when this session started
  message: string | null; // one plain sentence for "waiting" and "error"
  errorCode: UploadErrorCode | null;
  canRetry: boolean; // "Try again" makes sense for this error
  autoStart: boolean; // "Generate" was pressed: the project starts as soon as the upload ends
  project: Project | null;
  parallel: number; // chunk requests travelling at once right now (diagnostics)
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

export type UploadOptions = {
  /** Continue exactly this unfinished upload. A file that is not the same one is refused. */
  expect?: Pick<ServerUpload, "id" | "size" | "filename">;
  /** Fixed number of chunk requests at once (diagnostics and tests). Default: adapts between 1 and 4. */
  parallel?: number;
};

/** Must match VIDEO_EXTS in backend/app/pipeline/ingest.py: the server refuses everything else. */
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts"];

export function isVideoFileName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

const MAX_PARALLEL = 4;
const CHUNK_TIMEOUT_MS = 240_000; // hard stop, under the proxy's 5 minute limit for a request body
const STALL_MS = 30_000; // a request that moved no bytes for this long is dropped and retried
const RESPONSE_STALL_MS = 60_000; // body fully sent, still no answer
const MAX_BACKOFF_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;
const COMPLETE_TIMEOUT_MS = 120_000; // the server flushes a multi-GB file to disk before it answers
const SAMPLE_EVERY_MS = 500;
const SPEED_WINDOW_MS = 15_000; // "290 KB/s"
const ETA_WINDOW_MS = 60_000; // time left is worked out from a longer stretch, so it does not jump
const EMIT_EVERY_MS = 500; // bytes and bar
const NUMBERS_EVERY_MS = 2_000; // speed and time left
// Parallel requests. One request at a time already keeps the line full, because the next chunk
// starts as soon as the previous one has left the browser (it does not wait for the answer).
// Over HTTP/2 every request shares one connection, so more of them cannot add bandwidth: they
// only make each chunk slower and throw more away when the line drops. So the uploader TRIES
// one more request from time to time and keeps it only when the measured speed really went up
// (several HTTP/1.1 connections, or a proxy that limits each stream).
const EPOCH_MS = 10_000; // how long one level is measured
const SETTLE_MS = 2_000; // ignored after a change of level
const PROBE_GAIN = 1.2; // one more request must bring 20% more speed to stay
const PROBE_HOLD_MS = 60_000; // after a try that did not help, wait this long (doubles each time)
const PROBE_HOLD_MAX_MS = 600_000;
const MAX_CHUNK_SECONDS = 30; // never split the line so far that one chunk takes longer than this

type Flight = { xhr: XMLHttpRequest; bytes: number; loaded: number; moved: number; bodySent: boolean; fail: (status: number) => void };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean; timeout?: number } = {}): Promise<T> {
  const ctl = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = setTimeout(() => ctl?.abort(), opts.timeout ?? CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      keepalive: opts.keepalive,
      signal: ctl?.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, "Network error");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new HttpError(res.status, await detail(res));
  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError(0, "Network error"); // the answer was cut off: same as no answer
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return typeof j.detail === "string" ? j.detail : "";
  } catch {
    return "";
  }
}

function parseDetail(text: string): string {
  try {
    const d = JSON.parse(text).detail;
    return typeof d === "string" ? d : "";
  } catch {
    return "";
  }
}

/** Worth retrying by itself: no response at all, timeouts, rate limits, proxy and server hiccups. */
const transient = (status: number) => status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 507);

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const SAFE = "Your progress is safe.";
const TROUBLE = {
  offline: `You are offline. The upload continues by itself when you are back. ${SAFE}`,
  network: `Connection problem. Trying again by itself. ${SAFE}`,
  server: `The server is not answering right now. Trying again by itself. ${SAFE}`,
  slow: `The connection is very slow right now. Still trying. ${SAFE}`,
};

/** Plain words for the answers the server can give (see init_upload and put_chunk). */
function explain(status: number, serverText: string, where: "start" | "chunk" = "start"): { code: UploadErrorCode; message: string; canRetry: boolean } {
  if (status === 401) return { code: "signed-out", message: `You were signed out. Sign in again to continue. ${SAFE}`, canRetry: true };
  if (status === 400 && where === "start")
    return { code: "not-video", message: "This file is not a video we can use. Choose an MP4, MOV, MKV or WEBM file.", canRetry: false };
  if (status === 413 && where === "chunk")
    return { code: "server", message: `The server (or a proxy in front of it) refuses pieces of this size. ${SAFE}`, canRetry: true };
  if (status === 413) {
    const limit = /limit is ([\d.]+ ?GB)/i.exec(serverText)?.[1];
    return { code: "too-large", message: limit ? `This video is too big. The limit is ${limit}.` : "This video is too big for this server.", canRetry: false };
  }
  if (status === 507)
    return { code: "server-full", message: "The server is out of storage space. Delete old projects to make room, then try again.", canRetry: true };
  return { code: "server", message: serverText || "The server refused the upload. Try again.", canRetry: true };
}

/** Same file => same string, even after a rename, a refresh or on another device.
 *  Size plus a hash of three 256 KB samples (start, middle, end): instant even for 5 GB. */
export async function fingerprint(file: File): Promise<string> {
  const sample = 256 * 1024;
  const mid = Math.max(0, Math.floor(file.size / 2) - sample / 2);
  // reading throws when the file is gone: the caller reports that
  const parts = await Promise.all(
    [file.slice(0, sample), file.slice(mid, mid + sample), file.slice(Math.max(0, file.size - sample))].map((b) => b.arrayBuffer()),
  );
  try {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      all.set(new Uint8Array(p), at);
      at += p.byteLength;
    }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return `${file.size}-${Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // crypto.subtle only exists on https / localhost: fall back to a simple hash of the same samples
    let h = 5381;
    for (const p of parts) {
      const v = new Uint8Array(p);
      for (let i = 0; i < v.length; i += 97) h = ((h << 5) + h + v[i]) >>> 0;
    }
    return `${file.size}-s${h.toString(16)}`;
  }
}

// Which fingerprint each unfinished upload had, so "continue" can refuse a wrong file before
// anything is sent. Only a convenience: the server compares fingerprints as well.
const FP_KEY = "autoclip:upload-fingerprints";
function knownFingerprints(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(FP_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function rememberFingerprint(id: string, fp: string) {
  try {
    const all = Object.entries({ ...knownFingerprints(), [id]: fp }).slice(-12);
    localStorage.setItem(FP_KEY, JSON.stringify(Object.fromEntries(all)));
  } catch {}
}
function forgetFingerprint(id: string) {
  try {
    const all = knownFingerprints();
    delete all[id];
    localStorage.setItem(FP_KEY, JSON.stringify(all));
  } catch {}
}

export const listUnfinishedUploads = () => call<ServerUpload[]>("GET", "/api/uploads");
export const discardUpload = (id: string) => {
  forgetFingerprint(id);
  return call<{ ok: boolean }>("DELETE", `/api/uploads/${id}`);
};

export class ResumableUpload {
  readonly file: File;
  private expect: UploadOptions["expect"];
  private readonly fixedParallel: number | null;
  private state: UploadState;
  private listeners = new Set<(s: UploadState) => void>();

  private id: string | null = null;
  private fp: string | null = null;
  private chunkSize = 0;
  private total = 0;
  private have: Uint8Array = new Uint8Array(0); // 1 = the server confirmed this chunk
  private haveCount = 0;
  private confirmed = 0; // bytes in confirmed chunks
  private cursor = 0; // every chunk before this index is confirmed or in flight
  private recent = new Set<number>(); // chunks confirmed while the last "what do you have?" travelled
  private flying = new Map<number, Flight>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private armed = false;
  private op = 0; // only the newest prepare / resync / complete may continue after its await

  private failures = 0; // rounds of trouble in a row
  private slowTimeouts = 0; // chunks in a row that were still moving when the hard timeout hit
  private restarts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private settings: GenerationSettings | null = null;

  // numbers
  private samples: { t: number; bytes: number }[] = [];
  private lastEmit = 0;
  private lastNumbers = 0;
  private etaAt = 0;

  // parallel requests
  private parallel = 1;
  private meter: { t0: number; b0: number } | null = null;
  private meterFrom = 0;
  private probe: { from: number; baseline: number } | null = null;
  private probeHold = PROBE_HOLD_MS;
  private nextProbeAt = 0;

  private onOnline = () => {
    // do not wait out the backoff once the network is back (give it a second to really be there)
    if (this.state.phase !== "waiting") return;
    this.clearRetry();
    this.retryTimer = setTimeout(() => this.kick(), 1000);
  };
  private onOffline = () => {
    if (this.state.phase !== "uploading" && this.state.phase !== "preparing") return;
    this.abortFlying(); // these requests are dead; what they carried is sent again later
    this.trouble("offline");
  };
  private onVisible = () => {
    if (document.visibilityState === "visible" && this.state.phase === "waiting" && !offline()) this.onOnline();
  };

  constructor(file: File, options: UploadOptions = {}) {
    this.file = file;
    this.expect = options.expect;
    this.fixedParallel = options.parallel ? Math.max(1, Math.min(MAX_PARALLEL, Math.floor(options.parallel))) : null;
    if (this.fixedParallel) this.parallel = this.fixedParallel;
    this.state = {
      id: null, phase: "preparing", fileName: file.name, size: file.size, sent: 0, safe: 0, speed: 0, eta: null, resumedFrom: 0,
      message: null, errorCode: null, canRetry: false, autoStart: false, project: null, parallel: this.parallel,
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

  /** Starts (or resumes) right away. */
  async start() {
    this.arm();
    await this.prepare();
  }

  pause() {
    if (!["preparing", "uploading", "waiting"].includes(this.state.phase)) return;
    this.op++;
    this.clearRetry();
    this.abortFlying();
    this.set({ phase: "paused", sent: this.confirmed, safe: this.confirmed, speed: 0, eta: null, message: null });
  }

  resume() {
    if (this.state.phase === "paused") {
      this.failures = 0;
      this.set({ phase: "preparing" });
      this.kick();
    } else if (this.state.phase === "waiting") {
      this.clearRetry();
      this.kick();
    }
  }

  /** "Try again" after an error that the user may have fixed (signed in again, made room, better connection). */
  retry() {
    if (this.state.phase !== "error" || !this.state.canRetry) return;
    this.arm();
    this.failures = 0;
    this.slowTimeouts = 0;
    this.restarts = 0;
    this.set({ phase: "preparing", message: null, errorCode: null, canRetry: false });
    this.kick();
  }

  /** "Generate" pressed. If bytes are still travelling, the project is created the moment they are all in.
   *  Calling it again only swaps the settings. */
  finish(settings: GenerationSettings) {
    if (["finishing", "done", "canceled"].includes(this.state.phase)) return;
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
    const keep = !!this.state.project || this.state.phase === "finishing"; // too late: the project exists (or is being made)
    this.teardown();
    this.set({ phase: "canceled", speed: 0, eta: null, message: null });
    if (id && !keep) {
      forgetFingerprint(id);
      await call("DELETE", `/api/uploads/${id}`, undefined, { keepalive: true }).catch(() => {});
    }
  }

  /** Stops talking to the server but leaves the bytes there (page is going away). */
  dispose() {
    this.teardown();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ steps
  private arm() {
    if (this.armed) return;
    this.armed = true;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.watchdog = setInterval(() => this.dropStalled(), 5000);
  }

  /** Carry on from whatever the server has. */
  private kick() {
    this.clearRetry();
    if (["done", "canceled", "error", "finishing"].includes(this.state.phase)) return;
    if (!this.id) void this.prepare();
    else void this.resync();
  }

  private async readable(): Promise<boolean> {
    try {
      await this.file.slice(0, 1).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }

  private fileGone() {
    this.fail("file-gone", "The file can no longer be read. It was moved, renamed or changed. Choose it again to continue.", false);
  }

  private async prepare() {
    const op = ++this.op;
    if (this.state.phase !== "preparing") this.set({ phase: "preparing", message: null });
    try {
      if (!this.fp) {
        try {
          this.fp = await fingerprint(this.file);
        } catch {
          if (op === this.op) this.fileGone();
          return;
        }
        if (op !== this.op) return;
      }
      const want = this.expect;
      if (want) {
        const known = knownFingerprints()[want.id];
        if (this.file.size !== want.size || (known && known !== this.fp)) return this.wrongFile();
      }
      const up = await call<ServerUpload>("POST", "/api/uploads", { filename: this.file.name, size: this.file.size, fingerprint: this.fp });
      if (this.state.phase === "canceled") {
        // cancelled while the request travelled: cancel means the bytes go away
        void call("DELETE", `/api/uploads/${up.id}`, undefined, { keepalive: true }).catch(() => {});
        return;
      }
      if (op !== this.op) return;
      if (want && up.id !== want.id) {
        // The server did not match this file to the unfinished upload. Either it is another file,
        // or the unfinished upload has expired in the meantime.
        let expired = false;
        try {
          await call<ServerUpload>("GET", `/api/uploads/${want.id}`);
        } catch (e) {
          expired = (e as HttpError).status === 404;
        }
        if (op !== this.op) return;
        if (!expired) {
          if (!up.received_bytes) await call("DELETE", `/api/uploads/${up.id}`).catch(() => {}); // the empty upload just made
          if (op === this.op) this.wrongFile();
          return;
        }
        this.expect = undefined; // nothing left to continue: this one simply starts from the beginning
      }
      this.adopt(up);
      rememberFingerprint(up.id, this.fp);
      this.set({ id: up.id, sent: this.confirmed, safe: this.confirmed, resumedFrom: this.confirmed });
      this.enterUploading();
    } catch (e) {
      if (op !== this.op) return;
      const err = e as HttpError;
      const status = err.status ?? 0;
      if (transient(status)) return this.trouble(status === 0 ? "network" : "server");
      const x = explain(status, err.message);
      this.fail(x.code, x.message, x.canRetry);
    }
  }

  private wrongFile() {
    const want = this.expect;
    this.fail("different-file", want ? `That is a different file. To continue, choose "${want.filename}" again.` : "That is a different file.", false);
  }

  private adopt(up: ServerUpload) {
    this.id = up.id;
    this.chunkSize = up.chunk_size;
    this.total = up.total_chunks;
    this.have = new Uint8Array(this.total);
    this.merge(up.received);
    this.cursor = 0;
  }

  /** The server's list is the truth. `also`: chunks it confirmed to us after that list was made. */
  private merge(received: number[], also?: Set<number>) {
    this.have.fill(0);
    for (const i of received) if (i >= 0 && i < this.total) this.have[i] = 1;
    if (also) for (const i of also) this.have[i] = 1;
    let count = 0;
    let bytes = 0;
    for (let i = 0; i < this.total; i++) {
      if (!this.have[i]) continue;
      count++;
      bytes += this.chunkBytes(i);
    }
    this.haveCount = count;
    this.confirmed = bytes;
  }

  private chunkBytes(i: number) {
    return Math.max(0, Math.min(this.chunkSize, this.file.size - i * this.chunkSize));
  }

  private enterUploading() {
    this.cursor = 0;
    this.samples = [];
    this.resetMeter();
    this.set({ phase: "uploading", message: null, errorCode: null, canRetry: false, speed: 0, eta: null });
    this.progress(true);
    this.pump();
  }

  private nextMissing(): number {
    while (this.cursor < this.total && (this.have[this.cursor] || this.flying.has(this.cursor))) this.cursor++;
    return this.cursor < this.total ? this.cursor : -1;
  }

  private pump() {
    if (this.state.phase !== "uploading") return;
    for (;;) {
      // A chunk whose body has left the browser only waits for the server's "got it": the next one
      // may start already, so the line never sits idle between chunks.
      let sending = 0;
      for (const f of this.flying.values()) if (!f.bodySent) sending++;
      if (sending >= this.parallel || this.flying.size > this.parallel) break;
      const i = this.nextMissing();
      if (i < 0) break;
      this.send(i);
    }
    if (this.flying.size === 0 && this.haveCount === this.total) {
      this.set({ phase: "uploaded", sent: this.file.size, safe: this.file.size, speed: 0, eta: null, message: null });
      if (this.settings) void this.complete();
    }
  }

  private send(i: number) {
    const start = i * this.chunkSize;
    const bytes = this.chunkBytes(i);
    const xhr = new XMLHttpRequest();
    const settle = (ok: boolean, status: number, text: string) => {
      if (this.flying.get(i) !== slot) return; // aborted by pause / cancel, or already settled
      this.flying.delete(i);
      if (!ok) return this.chunkFailed(i, status, text, slot);
      if (!this.have[i]) {
        this.have[i] = 1;
        this.haveCount++;
        this.confirmed += bytes;
      }
      this.recent.add(i);
      this.failures = 0;
      this.slowTimeouts = 0;
      this.progress(true);
      this.pump();
    };
    const slot: Flight = { xhr, bytes, loaded: 0, moved: Date.now(), bodySent: false, fail: (status) => settle(false, status, "") };
    this.flying.set(i, slot);
    xhr.open("PUT", `/api/uploads/${this.id}/chunks/${i}`);
    xhr.withCredentials = true;
    xhr.timeout = CHUNK_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (this.flying.get(i) !== slot) return;
      slot.loaded = Math.min(bytes, e.loaded);
      slot.moved = Date.now();
      this.progress();
    };
    xhr.upload.onload = () => {
      if (this.flying.get(i) !== slot) return;
      slot.loaded = bytes;
      slot.moved = Date.now();
      slot.bodySent = true;
      this.pump();
    };
    xhr.onload = () => settle(xhr.status === 200, xhr.status, xhr.responseText);
    xhr.onerror = () => settle(false, 0, "");
    xhr.ontimeout = () => settle(false, slot.bodySent ? 0 : -1, ""); // -1: bytes were still moving, the line is just too slow
    // a slice is only a window on the file: nothing is read into memory, however big the video is
    xhr.send(this.file.slice(start, start + bytes));
  }

  private chunkFailed(i: number, status: number, text: string, slot?: Flight) {
    this.cursor = Math.min(this.cursor, i);
    if (this.state.phase !== "uploading" && this.state.phase !== "waiting") return;
    if (status === 404) return void this.lost(); // the server no longer has this upload (expired, cancelled elsewhere)
    if (status === 409) return void this.resync(); // finished from another tab
    if (status === -1) {
      // the proxy gives a request body five minutes; this chunk did not make it in four
      this.slowTimeouts++;
      if (this.slowTimeouts >= 3 && slot && slot.loaded < slot.bytes)
        return this.fail(
          "too-slow",
          `This connection is too slow to send the video right now. If the video is already online, paste its link instead, or try again on a faster connection. ${SAFE}`,
          true,
        );
      return this.trouble("slow");
    }
    if (status === 401 || status === 413 || status === 507) {
      const x = explain(status, parseDetail(text), "chunk");
      return this.fail(x.code, x.message, x.canRetry);
    }
    // Everything else (no answer, proxy errors, a body cut short) is worth another try. If the
    // server keeps refusing with a real answer, stop and say so instead of looping forever.
    if (status !== 0 && !transient(status) && this.failures >= 4)
      return this.fail("server", parseDetail(text) || `The server keeps refusing the upload. Try again in a moment. ${SAFE}`, true);
    this.trouble(status === 0 ? "network" : "server");
  }

  private inFlight() {
    let n = 0;
    for (const f of this.flying.values()) n += f.loaded;
    return n;
  }

  /** Stop starting new chunks and try again after a growing, jittered delay (about 1s, 2s, 4s ... 30s), forever. */
  private trouble(kind: keyof typeof TROUBLE) {
    if (["paused", "canceled", "error", "done"].includes(this.state.phase)) return;
    const message = offline() ? TROUBLE.offline : TROUBLE[kind];
    if (this.state.phase === "waiting" && this.retryTimer) {
      // several chunks failing together are one round of trouble, not four
      if (message !== this.state.message) this.set({ message });
      return;
    }
    this.op++;
    this.failures++;
    this.stepDown();
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(10, this.failures - 1));
    const delay = base * (0.5 + Math.random() / 2);
    this.clearRetry();
    this.set({ phase: "waiting", message, sent: Math.min(this.file.size, this.confirmed + this.inFlight()), safe: this.confirmed, speed: 0, eta: null });
    this.retryTimer = setTimeout(() => this.kick(), delay);
    if (kind === "network")
      void this.readable().then((ok) => {
        // a file that vanished looks exactly like a dead connection to XMLHttpRequest
        if (!ok && this.state.phase === "waiting") this.fileGone();
      });
  }

  /** Ask the server which chunks it really has (a chunk whose answer got lost may be there), then carry on. */
  private async resync() {
    if (!this.id) return void this.prepare();
    const op = ++this.op;
    this.recent = new Set();
    try {
      const up = await call<ServerUpload>("GET", `/api/uploads/${this.id}`);
      if (op !== this.op || ["canceled", "error", "done", "finishing"].includes(this.state.phase)) return;
      if (up.status === "completed") {
        // finished from another tab (or our "complete" went through and only the answer got lost)
        this.abortFlying();
        this.set({ phase: "uploaded", sent: up.size, safe: up.size, autoStart: true, message: null });
        return void this.complete(true);
      }
      this.merge(up.received, this.recent);
      if (up.status === "completing") return this.trouble("server"); // being turned into a project right now: look again shortly
      this.set({ sent: this.confirmed, safe: this.confirmed });
      this.enterUploading();
    } catch (e) {
      if (op !== this.op) return;
      const err = e as HttpError;
      if (err.status === 404) return void this.lost();
      if (err.status === 401) {
        const x = explain(401, "");
        return this.fail(x.code, x.message, x.canRetry);
      }
      this.trouble(err.status ? "server" : "network");
    }
  }

  /** The server no longer has this upload: send the file again from the start (once or twice, not forever). */
  private async lost() {
    this.abortFlying();
    if (this.id) forgetFingerprint(this.id);
    this.id = null;
    if (++this.restarts > 2) return this.fail("server", "The server keeps losing this upload. Try again in a moment.", true);
    this.expect = undefined;
    this.confirmed = 0;
    this.set({ id: null, sent: 0, safe: 0, resumedFrom: 0, speed: 0, eta: null });
    await this.prepare();
  }

  private async complete(alreadyDone = false) {
    if (!this.id || (!this.settings && !alreadyDone) || this.state.phase === "finishing" || this.state.phase === "done") return;
    const op = ++this.op;
    this.clearRetry();
    this.set({ phase: "finishing", message: null });
    try {
      const project = await call<Project>(
        "POST", `/api/uploads/${this.id}/complete`, { settings: this.settings ?? undefined, start: true }, { timeout: COMPLETE_TIMEOUT_MS },
      );
      if (op !== this.op) return;
      forgetFingerprint(this.id);
      this.teardown();
      this.set({ phase: "done", project, sent: this.file.size, safe: this.file.size });
    } catch (e) {
      if (op !== this.op) return;
      const err = e as HttpError;
      const status = err.status ?? 0;
      this.set({ phase: "uploaded" }); // back to "all bytes are in"; trouble() or lost() take it from here
      if (status === 404) return void this.lost(); // expired while it sat there: it is sent again and then started
      // 409: chunks are missing after all, or another request is finishing it. Either way: look again shortly.
      // Repeating "complete" is safe: the server answers a second one with the same project.
      if (transient(status) || status === 409) return this.trouble(status === 0 ? "network" : "server");
      const x = explain(status, err.message);
      this.fail(x.code, x.message, x.canRetry);
    }
  }

  // ------------------------------------------------------------ numbers
  private progress(force = false) {
    const now = Date.now();
    const sent = Math.max(0, Math.min(this.confirmed + this.inFlight(), this.file.size));
    const last = this.samples[this.samples.length - 1];
    if (last && sent < last.bytes) {
      // a chunk was thrown away: measure afresh, and judge parallel requests afresh
      this.samples = [];
      this.resetMeter();
    }
    if (!last || sent < last.bytes || now - last.t >= SAMPLE_EVERY_MS) this.samples.push({ t: now, bytes: sent });
    while (this.samples.length > 2 && now - this.samples[0].t > ETA_WINDOW_MS) this.samples.shift();
    if (this.state.phase !== "uploading") return;
    if (!force && now - this.lastEmit < EMIT_EVERY_MS) return;
    this.lastEmit = now;
    this.tune(now, sent);
    const patch: Partial<UploadState> = { sent, safe: this.confirmed, parallel: this.parallel };
    if (now - this.lastNumbers >= NUMBERS_EVERY_MS || this.state.speed === 0) {
      const speed = this.rate(SPEED_WINDOW_MS, 3000, now);
      if (speed > 0) {
        this.lastNumbers = now;
        patch.speed = speed;
        patch.eta = this.steadyEta(now, sent);
      }
    }
    this.set(patch);
  }

  /** Bytes per second over the last `windowMs`; 0 until `minSpan` of measurements exist. */
  private rate(windowMs: number, minSpan: number, now: number): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    let first = s[0];
    for (const x of s) {
      if (now - x.t <= windowMs) break;
      first = x;
    }
    const lastS = s[s.length - 1];
    const span = lastS.t - first.t;
    if (span < minSpan) return 0;
    const r = ((lastS.bytes - first.bytes) / span) * 1000;
    return Number.isFinite(r) && r > 0 ? r : 0;
  }

  /** Time left from the long-window speed. Small disagreements just let the old value count down. */
  private steadyEta(now: number, sent: number): number | null {
    const r = this.rate(ETA_WINDOW_MS, 5000, now);
    if (!r) return this.state.eta;
    const fresh = Math.max(0, (this.file.size - sent) / r);
    const prev = this.state.eta;
    if (prev != null && this.etaAt) {
      const counted = Math.max(0, prev - (now - this.etaAt) / 1000);
      if (Math.abs(fresh - counted) <= Math.max(20, counted * 0.08)) {
        this.etaAt = now;
        return counted;
      }
    }
    this.etaAt = now;
    return fresh;
  }

  // ------------------------------------------------------------ parallel requests
  private resetMeter() {
    this.meter = null;
    this.meterFrom = Date.now() + SETTLE_MS;
  }

  private stepDown() {
    if (this.fixedParallel) return;
    if (this.probe) this.parallel = this.probe.from;
    this.parallel = Math.max(1, Math.floor(this.parallel / 2));
    this.probe = null;
    this.probeHold = Math.min(PROBE_HOLD_MAX_MS, this.probeHold * 2);
    this.nextProbeAt = Date.now() + this.probeHold;
    this.resetMeter();
  }

  /** Try one more request at a time; keep it only if the measured speed really went up. */
  private tune(now: number, sent: number) {
    if (this.fixedParallel || !this.chunkSize) return;
    if (!this.meter) {
      if (now >= this.meterFrom) this.meter = { t0: now, b0: sent };
      return;
    }
    const span = now - this.meter.t0;
    if (span < EPOCH_MS) return;
    const rate = ((sent - this.meter.b0) / span) * 1000;
    if (!(rate > 0)) return this.resetMeter();
    if (this.probe) {
      if (rate >= this.probe.baseline * PROBE_GAIN) {
        this.probeHold = PROBE_HOLD_MS; // it helped: this level stays, and the next one may be tried
        this.nextProbeAt = now;
      } else {
        this.parallel = this.probe.from; // no real gain: back to fewer, shorter requests
        this.probeHold = Math.min(PROBE_HOLD_MAX_MS, this.probeHold * 2);
        this.nextProbeAt = now + this.probeHold;
      }
      this.probe = null;
      return this.resetMeter();
    }
    const secondsPerChunk = (p: number) => (this.chunkSize * p) / rate;
    if (this.parallel > 1 && secondsPerChunk(this.parallel) > MAX_CHUNK_SECONDS * 2) {
      this.parallel--; // the line got slower: keep every request short
      return this.resetMeter();
    }
    if (this.parallel < MAX_PARALLEL && now >= this.nextProbeAt && secondsPerChunk(this.parallel + 1) <= MAX_CHUNK_SECONDS) {
      this.probe = { from: this.parallel, baseline: rate };
      this.parallel++;
      this.resetMeter();
      this.pump();
      return;
    }
    this.resetMeter(); // keep the baseline fresh
  }

  // ------------------------------------------------------------ housekeeping
  private dropStalled() {
    const now = Date.now();
    for (const f of [...this.flying.values()]) {
      if (now - f.moved < (f.bodySent ? RESPONSE_STALL_MS : STALL_MS)) continue;
      f.fail(0); // counts as a failed chunk (retried with backoff) ...
      f.xhr.abort(); // ... and the dead request is closed
    }
  }

  private abortFlying() {
    const flying = [...this.flying.values()];
    this.flying.clear();
    for (const f of flying) f.xhr.abort();
    this.cursor = 0;
    this.samples = [];
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private teardown() {
    this.op++;
    this.clearRetry();
    this.abortFlying();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.armed) {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    this.armed = false;
  }

  private fail(code: UploadErrorCode, message: string, canRetry: boolean) {
    this.teardown();
    this.set({ phase: "error", errorCode: code, message, canRetry, sent: this.confirmed, safe: this.confirmed, speed: 0, eta: null });
  }

  private set(patch: Partial<UploadState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn(this.state);
  }
}
