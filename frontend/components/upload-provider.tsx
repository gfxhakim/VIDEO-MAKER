"use client";

// One upload lives here, above every page, so it keeps running while the user picks a
// style, opens another project or browses clips. Pages read it with useUpload() (changes only
// when something happens) and useUploadProgress() (ticks twice a second while bytes move).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { mutate } from "swr";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, FileVideo, Lightbulb, Link2, Pause, Play, RotateCw, X } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { SIGNED_OUT_EVENT, type GenerationSettings } from "@/lib/api";
import { discardUpload, isVideoFileName, listUnfinishedUploads, ResumableUpload, type ServerUpload, type UploadState } from "@/lib/uploader";
import { cn, fmtBytes, fmtEta, fmtPercent, fmtSpeed, pctOf, splitFileName } from "@/lib/utils";

/** The parts of an upload that change rarely. Safe to read in big components. */
export type UploadSummary = Pick<UploadState, "id" | "phase" | "fileName" | "size" | "autoStart" | "message" | "errorCode" | "canRetry" | "resumedFrom"> & {
  /** The measured speed means a long wait: time to suggest pasting a link instead. */
  slow: boolean;
};

type UploadCtx = {
  upload: UploadSummary | null; // the upload running in this tab
  unfinished: ServerUpload[]; // uploads the server still holds from an earlier visit
  /** Starts sending right away. `resume`: continue exactly that unfinished upload (another file is refused). False: nothing started. */
  start: (file: File, opts?: { resume?: ServerUpload }) => boolean;
  pause: () => void;
  resume: () => void;
  retry: () => void;
  /** Stops and deletes the bytes on the server. Asks first when a real amount is already up. */
  cancel: () => void;
  generate: (settings: GenerationSettings) => void; // now, or as soon as the last byte is in
  undoGenerate: () => void;
  /** What a queued "Generate" will use, so a page that opens again shows the same choice. Null when nothing is queued. */
  queuedSettings: () => GenerationSettings | null;
  discard: (id: string) => void;
  dismissSlowHint: () => void;
};

const Ctx = createContext<UploadCtx | null>(null);
const TickCtx = createContext<UploadState | null>(null);

export function useUpload() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUpload must be used inside <UploadProvider>");
  return ctx;
}

/** Live numbers (bytes, speed, time left). Re-renders about twice a second while uploading. */
export function useUploadProgress() {
  return useContext(TickCtx);
}

const RUNNING = ["preparing", "uploading", "waiting", "finishing"]; // bytes are (or are about to be) on the move
const SLOW_ETA_SECONDS = 600;
// Diagnostics, off unless set by hand in localStorage:
const DEBUG_PARALLEL_KEY = "autoclip:upload-parallel"; // "1".."4": fixed number of parallel chunk requests
const DEBUG_STATE_KEY = "autoclip:upload-debug"; // any value: mirror the live upload state to window.__uploadState

function summarize(s: UploadState, slow: boolean): UploadSummary {
  return {
    id: s.id, phase: s.phase, fileName: s.fileName, size: s.size, autoStart: s.autoStart, message: s.message,
    errorCode: s.errorCode, canRetry: s.canRetry, resumedFrom: s.resumedFrom, slow,
  };
}
const sameSummary = (a: UploadSummary | null, b: UploadSummary) =>
  !!a && (Object.keys(b) as (keyof UploadSummary)[]).every((k) => a[k] === b[k]);

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const { user, refresh: refreshAuth } = useAuth();
  const router = useRouter();
  const path = usePathname() || "/";
  const pathRef = useRef(path);
  const current = useRef<ResumableUpload | null>(null);
  const [tick, setTick] = useState<UploadState | null>(null);
  const [upload, setUpload] = useState<UploadSummary | null>(null);
  const [unfinished, setUnfinished] = useState<ServerUpload[]>([]);
  const [announce, setAnnounce] = useState("");
  const slow = useRef({ since: 0, latched: false, dismissed: false });
  const greeted = useRef(false);
  const debug = useRef(false);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  const loadUnfinished = useCallback(() => {
    listUnfinishedUploads().then(setUnfinished).catch(() => {});
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (userId == null) return;
    loadUnfinished();
    if (current.current?.getState().errorCode === "signed-out") current.current.retry(); // signed in again: carry on, the file is still in this tab
  }, [userId, loadUnfinished]);

  // Another request (a background refresh of a list, say) may notice the lost session first. With an
  // upload in this tab, go to the sign-in page without a page load, so the picked file is not lost.
  useEffect(() => {
    const onSignedOut = (e: Event) => {
      if (!current.current) return;
      e.preventDefault();
      void refreshAuth();
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [refreshAuth]);

  const publish = useCallback((up: ResumableUpload, s: UploadState) => {
    if (current.current !== up) return;
    if (debug.current) (window as unknown as { __uploadState?: UploadState }).__uploadState = s;
    // one calm hint: only once the time left has stayed long for a few seconds (the first estimate is rough)
    const h = slow.current;
    if (s.phase === "uploading" && s.eta != null && s.eta > SLOW_ETA_SECONDS) {
      if (!h.since) h.since = Date.now();
      else if (Date.now() - h.since > 6000) h.latched = true;
    } else if (s.phase === "uploading" && s.eta != null) h.since = 0;
    const ended = ["uploaded", "finishing", "done", "canceled"].includes(s.phase);
    const next = summarize(s, h.latched && !h.dismissed && !ended);
    setTick(s);
    setUpload((prev) => (sameSummary(prev, next) ? prev : next));
  }, []);

  const clear = useCallback(() => {
    current.current = null;
    setTick(null);
    setUpload(null);
  }, []);

  const start = useCallback(
    (file: File, opts?: { resume?: ServerUpload }) => {
      if (!isVideoFileName(file.name)) {
        toast.error("That file type is not supported", { description: "Choose an MP4, MOV, MKV or WEBM video." });
        return false;
      }
      if (!file.size) {
        toast.error("That file is empty", { description: "Choose a different video." });
        return false;
      }
      const old = current.current;
      const was = old?.getState();
      if (old && was && !["error", "canceled", "done"].includes(was.phase)) {
        if (old.file.name === file.name && old.file.size === file.size && old.file.lastModified === file.lastModified) return true; // same file again
        toast.error(was.phase === "uploaded" ? "A video is already uploaded" : "An upload is already running", {
          description: `Remove "${was.fileName}" first if you want to send a different video.`,
        });
        return false;
      }
      old?.dispose(); // a failed upload keeps its bytes on the server: picking the same file again continues it
      let parallel: number | undefined;
      try {
        parallel = Number(localStorage.getItem(DEBUG_PARALLEL_KEY)) || undefined;
        debug.current = !!localStorage.getItem(DEBUG_STATE_KEY);
      } catch {}
      slow.current = { since: 0, latched: false, dismissed: false };
      greeted.current = false;
      const up = new ResumableUpload(file, { expect: opts?.resume, parallel });
      current.current = up;
      publish(up, up.getState());
      up.subscribe((s) => publish(up, s));
      void up.start();
      return true;
    },
    [publish],
  );

  const cancel = useCallback(() => {
    const up = current.current;
    if (!up) return;
    const s = up.getState();
    if (s.phase === "finishing") return; // the project is being created right now
    if (s.phase === "error") {
      // put a failed upload aside without deleting what is already on the server: it is offered again as "continue"
      up.dispose();
      clear();
      loadUnfinished();
      return;
    }
    if (s.safe > 0) {
      const ok = window.confirm(`Cancel the upload of "${s.fileName}"?\n\nThe ${fmtBytes(s.safe)} already uploaded will be deleted from the server.`);
      if (!ok) return;
    }
    clear();
    if (s.id) setUnfinished((list) => list.filter((x) => x.id !== s.id)); // being deleted: nothing to continue
    void up.cancel().then(loadUnfinished);
  }, [clear, loadUnfinished]);

  const discard = useCallback((id: string) => {
    setUnfinished((list) => list.filter((u) => u.id !== id));
    void discardUpload(id).catch(() => {});
  }, []);

  const actions = useMemo(
    () => ({
      pause: () => current.current?.pause(),
      resume: () => current.current?.resume(),
      retry: () => current.current?.retry(),
      generate: (settings: GenerationSettings) => current.current?.finish(settings),
      undoGenerate: () => current.current?.cancelFinish(),
      queuedSettings: () => current.current?.getSettings() ?? null,
      dismissSlowHint: () => {
        slow.current.dismissed = true;
        setUpload((u) => (u && u.slow ? { ...u, slow: false } : u));
      },
    }),
    [],
  );

  // things that happen once per phase change
  const phase = upload?.phase;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const s = current.current?.getState();
    if (!s || !phase) {
      handled.current = null;
      return;
    }
    if (handled.current === phase) return; // only a real change of phase, never a re-run of this effect
    handled.current = phase;
    const onStudio = pathRef.current === "/";
    if (phase === "uploading" && s.resumedFrom > 0 && !greeted.current) {
      greeted.current = true;
      toast.success("Picking up where it stopped", { description: `${fmtBytes(s.resumedFrom)} of ${fmtBytes(s.size)} was already safe on the server.` });
      loadUnfinished();
    }
    if (phase === "uploaded" && !s.autoStart) {
      setAnnounce("Upload complete.");
      if (!onStudio) toast.success("Upload finished", { description: "Pick a style to start your clips.", action: { label: "Open Studio", onClick: () => router.push("/") } });
    }
    if (phase === "paused") setAnnounce("Upload paused.");
    if (phase === "waiting") setAnnounce(s.message ?? "Connection problem.");
    if (phase === "error") {
      setAnnounce(s.message ?? "Upload stopped.");
      if (s.errorCode === "signed-out") void refreshAuth(); // the auth guard sends them to the sign-in page
      else if (!onStudio) toast.error("Upload stopped", { description: s.message ?? undefined });
      loadUnfinished();
    }
    if (phase === "done" && s.project) {
      const project = s.project;
      clear();
      setUnfinished((list) => list.filter((x) => x.id !== s.id)); // finished: nothing left to continue
      loadUnfinished();
      setAnnounce("Upload complete. Your clips are being made.");
      void mutate(`/api/projects/${project.id}`, project, { revalidate: false }); // the project page opens without a loading state
      void mutate("/api/projects");
      if (onStudio) router.push(`/project?id=${project.id}`);
      toast.success("Upload finished. Your clips are cooking", {
        action: onStudio ? undefined : { label: "Open", onClick: () => router.push(`/project?id=${project.id}`) },
      });
    }
  }, [phase, clear, loadUnfinished, refreshAuth, router]);

  // closing the tab stops the upload (the bytes stay safe on the server): warn while it is running
  const running = !!phase && RUNNING.includes(phase);
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  // keep the screen awake while uploading (phones stop the network when they lock)
  useEffect(() => {
    if (!running || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let over = false;
    const acquire = async () => {
      if (over || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (over) void lock.release().catch(() => {});
      } catch {} // battery saver, or the browser said no: the upload still works
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire); // the lock is dropped whenever the tab is hidden
    return () => {
      over = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, [running]);

  // a file dropped next to the drop zone must not make the browser open it (that would end the upload)
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
      current.current?.dispose();
    };
  }, []);

  const activeId = upload?.id;
  const value = useMemo<UploadCtx>(
    () => ({ upload, unfinished: unfinished.filter((x) => x.id !== activeId), start, cancel, discard, ...actions }),
    [upload, unfinished, activeId, start, cancel, discard, actions],
  );

  const showDock = !!upload && path !== "/" && !path.startsWith("/signin") && upload.phase !== "canceled" && upload.phase !== "done";
  return (
    <Ctx.Provider value={value}>
      <TickCtx.Provider value={tick}>
        {children}
        {showDock && <UploadDock />}
        <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      </TickCtx.Provider>
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------------- pieces
type Tone = "normal" | "idle" | "warn" | "error" | "ok";

/** What to say about an upload, in the three sizes the UI needs. */
function describe(u: UploadState): { tone: Tone; pct: number; short: string; detail: string; full: string } {
  const pct = pctOf(u.sent, u.size);
  const of = `${fmtBytes(u.sent)} of ${fmtBytes(u.size)}`;
  switch (u.phase) {
    case "preparing":
      return { tone: "normal", pct, short: "Getting ready…", detail: "", full: "Getting ready…" };
    case "uploading": {
      const speed = fmtSpeed(u.speed);
      const eta = fmtEta(u.eta);
      const numbers = speed ? `${of} · ${speed}` : of;
      const left = eta || (speed ? "working out the time left…" : "measuring speed…");
      return { tone: "normal", pct, short: left, detail: numbers, full: `${numbers} · ${left}` };
    }
    case "paused": {
      const safe = `${fmtBytes(u.safe)} of ${fmtBytes(u.size)}`;
      return { tone: "idle", pct, short: "Paused", detail: `${safe} is safe`, full: `Paused. ${safe} is safe on the server.` };
    }
    case "waiting": {
      const m = u.message ?? "Connection problem. Trying again by itself. Your progress is safe.";
      return { tone: "warn", pct, short: m.split(". ")[0] + ".", detail: "Trying again by itself", full: m };
    }
    case "error": {
      const m = u.message ?? "The upload stopped.";
      return { tone: "error", pct, short: m, detail: "", full: m };
    }
    case "uploaded":
      if (!u.autoStart) return { tone: "ok", pct: 100, short: "Upload complete", detail: fmtBytes(u.size), full: `Upload complete · ${fmtBytes(u.size)}` };
    // falls through: Generate was already pressed
    default:
      return { tone: "ok", pct: 100, short: "Starting your clips…", detail: "Upload complete", full: "Upload complete. Starting your clips…" };
  }
}

const TEXT_TONE: Record<Tone, string> = { normal: "text-muted-foreground", idle: "text-muted-foreground", warn: "text-warning", error: "text-destructive", ok: "text-success" };
const BAR_TONE: Record<Tone, string> = {
  normal: "bg-gradient-to-r from-primary to-fuchsia-400",
  idle: "bg-white/40",
  warn: "bg-warning/80",
  error: "bg-destructive/70",
  ok: "bg-success",
};

function Bar({ pct, tone, busy, label, className }: { pct: number; tone: Tone; busy?: boolean; label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(pct)}
      aria-valuetext={label}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-white/10", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", BAR_TONE[tone], pct > 0 && "min-w-1.5", busy && "animate-pulse")}
        style={{ width: `${busy && pct < 3 ? 3 : pct}%` }}
      />
    </div>
  );
}

/** A file name that can never widen its parent: the middle is cut, the ending stays readable. */
export function FileName({ name, className }: { name: string; className?: string }) {
  const [base, ext] = splitFileName(name);
  return (
    <span title={name} className={cn("flex min-w-0", className)}>
      <span className="truncate">{base}</span>
      {ext && <span className="shrink-0">{ext}</span>}
    </span>
  );
}

const ICON_BTN =
  "grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/15 pointer-coarse:size-10";

/** Pause / resume / try again / cancel for the running upload. */
export function UploadControls({ className }: { className?: string }) {
  const u = useUploadProgress();
  const { pause, resume, retry, cancel } = useUpload();
  if (!u || u.phase === "finishing" || u.phase === "done" || u.phase === "canceled") return null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      {(u.phase === "uploading" || u.phase === "waiting" || u.phase === "preparing") && (
        <button type="button" className={ICON_BTN} onClick={stop(pause)} aria-label="Pause upload" title="Pause"><Pause className="size-4" /></button>
      )}
      {u.phase === "paused" && (
        <button type="button" className={cn(ICON_BTN, "text-foreground")} onClick={stop(resume)} aria-label="Resume upload" title="Resume"><Play className="size-4" /></button>
      )}
      {u.phase === "error" && u.canRetry && (
        <button type="button" className={cn(ICON_BTN, "text-foreground")} onClick={stop(retry)} aria-label="Try the upload again" title="Try again"><RotateCw className="size-4" /></button>
      )}
      <button type="button" className={ICON_BTN} onClick={stop(cancel)} aria-label={u.phase === "uploaded" || u.phase === "error" ? "Remove this video" : "Cancel upload"} title={u.phase === "uploaded" || u.phase === "error" ? "Remove" : "Cancel upload"}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * Progress of the running upload.
 *  - "card": bar with percent, then one line such as "412 MB of 1.94 GB · 290 KB/s · about 1 h 12 min left".
 *  - "line": one compact row (text, percent, thin bar) with the pause and cancel buttons; for footers.
 */
export function UploadProgress({ variant = "card", className }: { variant?: "card" | "line"; className?: string }) {
  const u = useUploadProgress();
  if (!u) return null;
  const d = describe(u);
  const busy = u.phase === "preparing" || u.phase === "finishing";
  if (variant === "line")
    return (
      <div className={cn("@container flex min-w-0 items-center gap-1", className)}>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className={cn("min-w-0 flex-1 truncate", TEXT_TONE[d.tone])}>
              {d.detail && u.phase !== "waiting" && <span className="hidden tabular-nums @md:inline">{d.detail} · </span>}
              {d.short}
            </span>
            <span className="shrink-0 font-medium text-foreground tabular-nums">{fmtPercent(d.pct)}</span>
          </div>
          <Bar pct={d.pct} tone={d.tone} busy={busy} label={d.full} className="mt-1.5 h-1.5" />
        </div>
        <UploadControls className="-mr-1.5" />
      </div>
    );
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-3">
        <Bar pct={d.pct} tone={d.tone} busy={busy} label={d.full} className="flex-1" />
        <span className="w-11 shrink-0 text-right text-xs font-medium tabular-nums">{fmtPercent(d.pct)}</span>
      </div>
      <p className={cn("mt-1.5 text-xs tabular-nums", TEXT_TONE[d.tone], (u.phase === "waiting" || u.phase === "error") && "wrap-anywhere")}>{d.full}</p>
    </div>
  );
}

/** "Starts by itself when the upload finishes" with a way to take it back. Shows nothing unless Generate was pressed early. */
export function QueuedNote({ compact, className }: { compact?: boolean; className?: string }) {
  const { upload: u, undoGenerate } = useUpload();
  if (!u || !u.autoStart || ["finishing", "done", "canceled", "uploaded"].includes(u.phase)) return null;
  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <p className="min-w-0 flex-1">
        <span className="text-foreground">Starts by itself when the upload finishes.</span>
        {!compact && " Keep this tab open."}
      </p>
      <button
        type="button"
        onClick={undoGenerate}
        className="-my-1 inline-flex h-8 shrink-0 items-center rounded-lg px-2.5 font-medium text-primary transition-colors hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/15 pointer-coarse:h-10 pointer-coarse:min-w-10"
      >
        Undo
      </button>
    </div>
  );
}

/** One calm hint when the upload will take long: the server can fetch a video that is already online much faster. */
export function SlowUploadHint({ onUseLink, className }: { onUseLink: () => void; className?: string }) {
  const { upload: u, dismissSlowHint } = useUpload();
  if (!u?.slow) return null;
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border border-white/10 bg-white/[.04] p-3 text-xs", className)}>
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">This will take a while on this connection.</p>
        <p className="mt-0.5 text-muted-foreground">
          Is the video already online, on YouTube or Google Drive for example? Paste its link and the server fetches it directly. That is usually much faster.
        </p>
        <button
          type="button"
          onClick={onUseLink}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[.06] px-3 font-medium text-foreground transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-10"
        >
          <Link2 className="size-3.5" /> Paste a link instead
        </button>
      </div>
      <button type="button" onClick={dismissSlowHint} aria-label="Hide this tip" className={cn(ICON_BTN, "-mt-1.5 -mr-1.5 size-8")}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------- dock
/** Height (px) taken at the bottom of the screen by a fixed bar such as the phone tab bar; 0 when there is none. */
function useBottomBar(): number | null {
  const path = usePathname();
  const [inset, setInset] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const vh = window.innerHeight;
      let top = vh;
      for (const nav of Array.from(document.querySelectorAll("nav"))) {
        const cs = getComputedStyle(nav);
        if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
        const r = nav.getBoundingClientRect();
        if (r.height < 8 || r.height > vh / 2 || r.bottom < vh - 48) continue; // not a bar along the bottom edge
        top = Math.min(top, r.top);
      }
      setInset(Math.max(0, Math.round(vh - top)));
    };
    measure();
    const t = setTimeout(measure, 400); // after the route's own layout settled
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [path]);
  return inset;
}

function Ring({ pct, tone }: { pct: number; tone: Tone }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const stroke = { normal: "stroke-primary", idle: "stroke-white/50", warn: "stroke-warning", error: "stroke-destructive", ok: "stroke-success" }[tone];
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0 -rotate-90" aria-hidden>
      <circle cx="16" cy="16" r={r} fill="none" strokeWidth="3" className="stroke-white/10" />
      <circle cx="16" cy="16" r={r} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} className={cn("transition-[stroke-dashoffset] duration-500", stroke)} />
    </svg>
  );
}

const DOCK_KEY = "autoclip:upload-dock";

/** Follows the user to the other pages while a file is still uploading. Sits above the phone tab bar,
 *  below dialogs, and folds down to a small pill. */
function UploadDock() {
  const u = useUploadProgress();
  const bar = useBottomBar();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);

  useLayoutEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(DOCK_KEY);
    } catch {}
    // small screens start folded: the pill covers almost nothing
    setOpen(saved ? saved === "open" : window.matchMedia("(min-width: 1024px)").matches);
  }, []);

  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      sessionStorage.setItem(DOCK_KEY, next ? "open" : "closed");
    } catch {}
  };

  // lets the page shell keep its last rows clear of the dock: padding-bottom: var(--upload-dock-h, 0px)
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--upload-dock-h", `${Math.ceil(el.getBoundingClientRect().height) + 12}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--upload-dock-h");
    };
  }, []);

  if (!u) return null;
  const d = describe(u);
  const pill = u.phase === "uploading" ? `${fmtPercent(d.pct)} · ${d.short}` : d.short;
  return (
    <div
      ref={box}
      style={bar == null ? undefined : { bottom: bar > 0 ? `${bar + 8}px` : "max(1.25rem, env(safe-area-inset-bottom))" }}
      className={cn(
        "pointer-events-none fixed right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] z-40 flex justify-end lg:right-6",
        bar == null && "bottom-24 lg:bottom-6",
      )}
    >
      {open ? (
        <section aria-label="Video upload" className="pointer-events-auto w-full max-w-md rounded-2xl border bg-card/95 p-3.5 shadow-2xl backdrop-blur-xl sm:w-96">
          <div className="mb-2 flex items-center gap-2">
            <FileVideo className="size-4 shrink-0 text-primary" aria-hidden />
            <FileName name={u.fileName} className="flex-1 text-sm font-medium" />
            <UploadControls className="-my-1.5" />
            <button type="button" onClick={() => toggle(false)} aria-expanded aria-label="Fold the upload panel" title="Fold" className={cn(ICON_BTN, "-my-1.5 -mr-1.5")}>
              <ChevronDown className="size-4" />
            </button>
          </div>
          <UploadProgress />
          <QueuedNote compact className="mt-2" />
          {u.phase === "uploaded" && !u.autoStart && (
            <p className="mt-2 text-xs text-muted-foreground">
              <Link href="/" className="font-medium text-primary underline underline-offset-2 hover:text-foreground">Open Studio</Link> to pick a style and start your clips.
            </p>
          )}
        </section>
      ) : (
        <button
          type="button"
          onClick={() => toggle(true)}
          aria-expanded={false}
          aria-label={`Video upload: ${d.full}. Show details`}
          className="pointer-events-auto flex h-12 max-w-full items-center gap-2.5 rounded-full border bg-card/95 pr-3 pl-2 text-xs shadow-2xl backdrop-blur-xl transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Ring pct={d.pct} tone={d.tone} />
          <span className={cn("min-w-0 truncate tabular-nums", d.tone === "normal" ? "text-foreground" : TEXT_TONE[d.tone])}>{pill}</span>
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      )}
    </div>
  );
}
