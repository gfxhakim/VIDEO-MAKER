"use client";

// One upload lives here, above every page, so it keeps running while the user picks a
// style, opens another project or browses clips. Pages read it with useUpload().
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { mutate } from "swr";
import { toast } from "sonner";
import { FileVideo, Pause, Play, X } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Progress } from "@/components/ui/progress";
import type { GenerationSettings } from "@/lib/api";
import { discardUpload, listUnfinishedUploads, ResumableUpload, VIDEO_EXTENSIONS, type ServerUpload, type UploadState } from "@/lib/uploader";
import { cn, fmtBytes, fmtEta, fmtSpeed } from "@/lib/utils";

type UploadCtx = {
  upload: UploadState | null; // the upload running in this tab
  unfinished: ServerUpload[]; // uploads the server still holds from an earlier visit
  start: (file: File) => boolean; // false: not a video file
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  generate: (settings: GenerationSettings) => void; // now, or as soon as the last byte is in
  discard: (id: string) => void;
};

const Ctx = createContext<UploadCtx | null>(null);

export function useUpload() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUpload must be used inside <UploadProvider>");
  return ctx;
}

const BUSY = ["preparing", "uploading", "waiting", "paused", "finishing"];

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const path = usePathname() || "/";
  const current = useRef<ResumableUpload | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [unfinished, setUnfinished] = useState<ServerUpload[]>([]);
  const greeted = useRef(false);

  useEffect(() => {
    if (user) listUnfinishedUploads().then(setUnfinished).catch(() => {});
  }, [user]);

  const start = useCallback((file: File) => {
    const ext = file.name.includes(".") ? "." + file.name.split(".").pop()!.toLowerCase() : "";
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      toast.error("That is not a video file", { description: "Use MP4, MOV, MKV or WEBM." });
      return false;
    }
    void current.current?.cancel(); // choosing another file replaces the one in progress
    greeted.current = false;
    const up = new ResumableUpload(file);
    current.current = up;
    setUpload(up.getState());
    up.subscribe((s) => current.current === up && setUpload(s));
    void up.start();
    return true;
  }, []);

  const cancel = useCallback(() => {
    const up = current.current;
    current.current = null;
    setUpload(null);
    void up?.cancel().then(() => listUnfinishedUploads().then(setUnfinished).catch(() => {}));
  }, []);

  const discard = useCallback((id: string) => {
    setUnfinished((list) => list.filter((u) => u.id !== id));
    void discardUpload(id).catch(() => {});
  }, []);

  // things that happen once per phase change
  const phase = upload?.phase;
  useEffect(() => {
    if (!upload) return;
    if (phase === "uploading" && upload.resumedFrom > 0 && !greeted.current) {
      greeted.current = true;
      toast.success("Picking up where it stopped", { description: `${fmtBytes(upload.resumedFrom)} of ${fmtBytes(upload.size)} was already uploaded.` });
      setUnfinished([]);
    }
    if (phase === "done" && upload.project) {
      const id = upload.project.id;
      current.current = null;
      setUpload(null);
      void mutate("/api/projects");
      if (path === "/") router.push(`/project?id=${id}`);
      toast.success("Upload finished. Your clips are cooking", {
        action: path === "/" ? undefined : { label: "Open", onClick: () => router.push(`/project?id=${id}`) },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on phase changes only, not on every progress tick
  }, [phase]);

  // leaving mid-upload only pauses it, but warn anyway
  const busy = !!phase && BUSY.includes(phase);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const value: UploadCtx = {
    upload,
    unfinished,
    start,
    cancel,
    discard,
    pause: () => current.current?.pause(),
    resume: () => current.current?.resume(),
    generate: (settings) => current.current?.finish(settings),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {upload && path !== "/" && path !== "/signin" && <UploadDock />}
    </Ctx.Provider>
  );
}

/** Bar + "412 MB of 1.9 GB · 290 KB/s · about 1 h 12 min left" + pause / cancel. Used in the composer,
 *  in the style dialog footer and in the floating dock. */
export function UploadProgress({ className }: { className?: string }) {
  const { upload: u, pause, resume, cancel } = useUpload();
  if (!u) return null;
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  const of = `${fmtBytes(u.sent)} of ${fmtBytes(u.size)}`;
  const line =
    u.phase === "preparing" ? "Getting ready…"
    : u.phase === "uploading" ? `${of} · ${u.speed ? `${fmtSpeed(u.speed)} · ${fmtEta(u.eta)}` : "measuring speed…"}`
    : u.phase === "paused" ? `Paused at ${of}`
    : u.phase === "waiting" ? `${u.message ?? "Connection problem."} Trying again by itself. ${of} is safe.`
    : u.phase === "error" ? u.message ?? "Upload failed."
    : u.autoStart || u.phase === "finishing" ? "Upload complete. Starting your clips…"
    : `Upload complete · ${fmtBytes(u.size)}`;
  const canPause = u.phase === "uploading" || u.phase === "waiting";
  const btn = "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-2">
        <Progress value={pct} className={cn("flex-1", u.phase === "error" && "opacity-40")} />
        <span className="w-9 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{Math.floor(pct)}%</span>
        {canPause && <button type="button" className={btn} onClick={(e) => { e.stopPropagation(); pause(); }} aria-label="Pause upload"><Pause className="size-4" /></button>}
        {u.phase === "paused" && <button type="button" className={btn} onClick={(e) => { e.stopPropagation(); resume(); }} aria-label="Resume upload"><Play className="size-4" /></button>}
        <button type="button" className={btn} onClick={(e) => { e.stopPropagation(); cancel(); }} aria-label="Cancel upload"><X className="size-4" /></button>
      </div>
      <p role="status" className={cn("mt-1 text-xs text-muted-foreground", u.phase === "error" && "text-destructive", u.phase === "waiting" && "text-warning")}>{line}</p>
    </div>
  );
}

/** Follows the user to the other pages while a file is still uploading. Sits above the mobile tab bar. */
function UploadDock() {
  const { upload: u } = useUpload();
  if (!u) return null;
  return (
    <div className="glass fixed inset-x-3 bottom-24 z-40 rounded-2xl border p-4 shadow-2xl lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-96">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <FileVideo className="size-4 shrink-0 text-primary" />
        <span className="truncate font-medium">{u.fileName}</span>
      </div>
      <UploadProgress />
      {u.autoStart && u.phase !== "finishing" && <p className="mt-1 text-xs text-muted-foreground">Clips start by themselves when this finishes. Keep this tab open.</p>}
    </div>
  );
}
