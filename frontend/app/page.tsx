"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import useSWR, { mutate as globalMutate, preload } from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowRight, Check, CheckCircle2, Clapperboard, ClipboardPaste, Film, FileVideo, FolderOpen, Link2, Loader2, Minus, Plus, RotateCw, SearchCheck, Sparkles, Trash2,
  UploadCloud, Wand2, X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { FileName, QueuedNote, SlowUploadHint, UploadControls, UploadProgress, useUpload } from "@/components/upload-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { api, DEFAULT_SETTINGS, fetcher, isLive, quietFetcher, type Clip, type GenerationSettings, type Project, type URLProbeResult } from "@/lib/api";
import { VIDEO_EXTENSIONS, type ServerUpload } from "@/lib/uploader";
import { cn, fmtBytes, fmtDate, fmtDuration, pctOf } from "@/lib/utils";

const SOURCES = [
  { key: "upload", label: "Upload", short: "Upload", icon: UploadCloud },
  { key: "url", label: "Video link", short: "Link", icon: Link2 },
  { key: "path", label: "Server path", short: "Path", icon: FolderOpen },
] as const;
type Source = (typeof SOURCES)[number]["key"];

const ACCEPT = `video/*,${VIDEO_EXTENSIONS.join(",")}`;
const COUNT = { min: 1, max: 50, presets: [5, 10, 20, 30, 50] };

const projectsEvery = (list?: Project[]) => (list?.some(isLive) ? 2000 : 20000);
const SWR_PROJECTS = { refreshInterval: projectsEvery, errorRetryInterval: 2000 };
const SWR_CLIPS = { revalidateOnFocus: false, dedupingInterval: 10000 };

const early = new Map<string, { at: number; data: Promise<unknown> }>();
if (typeof window !== "undefined" && window.location.pathname === "/") {
  for (const key of ["/api/projects", "/api/clips"]) {
    const data = quietFetcher(key);
    data.catch(() => {});
    early.set(key, { at: Date.now(), data });
  }
}
function firstFetcher<T>(key: string): Promise<T> {
  const hit = early.get(key);
  early.delete(key);
  if (!hit || Date.now() - hit.at > 30_000) return fetcher<T>(key);
  return (hit.data as Promise<T>).catch(() => fetcher<T>(key));
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function toLink(raw: string): string | null {
  let s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    return u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseClockToSec(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

const FIELD =
  "flex h-12 items-center gap-2 rounded-2xl border border-white/10 bg-white/[.03] pr-1.5 pl-3.5 transition-colors focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/15 @[38rem]:h-14";
const FIELD_INPUT = "h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70 pointer-coarse:text-base";
const FIELD_BTN =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-10";
const SMALL_BTN =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs font-medium transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/15 pointer-coarse:h-10";
const PANEL_MIN = "@[38rem]:min-h-36 tall:@[38rem]:min-h-44";

function NewProjectWatcher({ onNew }: { onNew: () => void }) {
  const wantsNew = useSearchParams().get("new");
  const router = useRouter();
  useEffect(() => {
    if (!wantsNew) return;
    onNew();
    router.replace("/", { scroll: false });
  }, [wantsNew, onNew, router]);
  return null;
}

function UploadPanel({ drag, openPicker, onUseLink }: { drag: boolean; openPicker: (resume?: ServerUpload) => void; onUseLink: () => void }) {
  const { upload: u, unfinished, discard, retry } = useUpload();
  const leftover = unfinished.find((x) => x.received_bytes > 0 && x.status === "uploading");

  if (u) {
    const needsFile = u.errorCode === "file-gone" || u.errorCode === "different-file";
    return (
      <div className={cn("flex flex-col justify-center", PANEL_MIN)}>
        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-3.5 @[38rem]:p-4">
          <div className="flex items-center gap-3">
            <span className="bg-brand grid size-10 shrink-0 place-items-center rounded-xl"><FileVideo className="size-5 text-white" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <FileName name={u.fileName} className="text-sm font-medium" />
              <div className="text-xs text-muted-foreground">{fmtBytes(u.size)}</div>
            </div>
            <UploadControls className="-mr-1.5" />
          </div>
          <UploadProgress className="mt-3" />
          {u.phase === "uploaded" && !u.autoStart && <p className="mt-2 text-xs text-muted-foreground">Now choose a style to start your clips.</p>}
          {u.phase === "error" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {u.canRetry && <button type="button" onClick={retry} className={cn(SMALL_BTN, "bg-white/[.06]")}><RotateCw className="size-3.5" /> Try again</button>}
              {needsFile && <button type="button" onClick={() => openPicker(u.errorCode === "different-file" ? leftover : undefined)} className={cn(SMALL_BTN, "bg-white/[.06]")}>Choose the file again</button>}
              {!u.canRetry && !needsFile && <button type="button" onClick={() => openPicker()} className={cn(SMALL_BTN, "bg-white/[.06]")}>Choose another video</button>}
            </div>
          )}
          <QueuedNote className="mt-2" />
          <SlowUploadHint className="mt-3" onUseLink={onUseLink} />
        </div>
      </div>
    );
  }

  if (leftover && !drag) {
    const pct = pctOf(leftover.received_bytes, leftover.size);
    return (
      <div className={cn("flex flex-col justify-center", PANEL_MIN)}>
        <div className="rounded-2xl border border-primary/30 bg-primary/[.07] p-3.5 @[38rem]:p-4">
          <div className="flex min-w-0 text-sm font-medium">
            <span className="shrink-0 whitespace-pre">Continue uploading </span>
            <FileName name={leftover.filename} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="text-foreground">{fmtBytes(leftover.received_bytes)} of {fmtBytes(leftover.size)} is already safe.</span> Choose the same file again and it carries on
            from there. Kept until {fmtDate(leftover.expires_at)}.
          </p>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
            <div className="h-full min-w-1.5 rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-autofocus onClick={() => openPicker(leftover)} className={cn(SMALL_BTN, "border-transparent bg-primary px-4 text-primary-foreground hover:bg-primary/90 active:bg-primary/80")}>
              <UploadCloud className="size-3.5" /> Choose the file
            </button>
            <button type="button" onClick={() => openPicker()} className={SMALL_BTN}>Upload another video</button>
            <button
              type="button"
              onClick={() => window.confirm(`Delete the ${fmtBytes(leftover.received_bytes)} already uploaded of "${leftover.filename}"?`) && discard(leftover.id)}
              className={cn(SMALL_BTN, "border-transparent text-muted-foreground hover:text-destructive")}
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-autofocus
      onClick={() => openPicker()}
      className={cn(
        "group grid min-h-32 w-full place-items-center rounded-2xl border-2 border-dashed border-white/15 px-4 py-5 text-center text-sm text-muted-foreground outline-none transition",
        "hover:border-white/30 hover:bg-white/[.02] focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/25 active:bg-white/[.04]",
        PANEL_MIN,
        drag && "border-primary bg-primary/10 text-foreground",
      )}
    >
      <span className="block">
        <UploadCloud className={cn("mx-auto mb-2 size-9 text-primary transition-transform duration-200", drag ? "-translate-y-1 scale-110" : "group-hover:-translate-y-0.5")} aria-hidden />
        {drag ? (
          <span className="block text-foreground">Drop it to start uploading</span>
        ) : (
          <>
            <span className="block pointer-coarse:hidden"><span className="text-foreground">Drop your video here</span> or click to browse</span>
            <span className="hidden text-foreground pointer-coarse:block">Tap to choose a video</span>
          </>
        )}
        <span className="mt-1 block text-xs">MP4, MOV, MKV or WEBM. The upload starts right away.</span>
      </span>
    </button>
  );
}

function TextSource({
  id, label, icon: Icon, value, onChange, onEnter, placeholder, help, warn, mono, type, extraBtn,
}: {
  id: string; label: string; icon: React.ElementType; value: string; onChange: (v: string) => void; onEnter: () => void;
  placeholder: string; help: React.ReactNode; warn?: string | null; mono?: boolean; type: "url" | "text"; extraBtn?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => setCanPaste(typeof navigator !== "undefined" && !!navigator.clipboard?.readText), []);

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) onChange(text);
      else toast("Nothing to paste yet", { description: "Copy the link first." });
    } catch {
      input.current?.focus();
    }
  }

  return (
    <div className={cn("flex flex-col justify-center gap-2.5", PANEL_MIN)}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <div className={FIELD}>
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={input}
          id={id}
          data-autofocus
          type={type}
          inputMode={type === "url" ? "url" : undefined}
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter()}
          placeholder={placeholder}
          aria-describedby={`${id}-help`}
          aria-invalid={!!warn}
          className={cn(FIELD_INPUT, mono && "font-mono")}
        />
        {extraBtn}
        {value ? (
          <button type="button" onClick={() => { onChange(""); input.current?.focus(); }} className={cn(FIELD_BTN, "w-9 justify-center px-0 pointer-coarse:w-10")} aria-label={`Clear the ${label.toLowerCase()}`}>
            <X className="size-4" />
          </button>
        ) : (
          canPaste && <button type="button" onClick={paste} className={FIELD_BTN}><ClipboardPaste className="size-4" /> Paste</button>
        )}
      </div>
      <p id={`${id}-help`} className={cn("text-xs", warn ? "text-warning" : "text-muted-foreground")}>{warn || help}</p>
    </div>
  );
}

function Stats({ projects, clips }: { projects?: Project[]; clips?: Clip[] }) {
  const items = [
    { label: "Projects", value: projects?.length, icon: Clapperboard },
    { label: "Clips ready", value: clips?.length, icon: Film },
    { label: "Approved", value: clips?.filter((c) => c.review_status === "approved").length, icon: CheckCircle2 },
    { label: "Posted", value: clips?.filter((c) => Object.keys(c.posted ?? {}).length).length, icon: Sparkles },
  ];
  return (
    <dl className="mb-6 grid grid-cols-4 gap-2 sm:gap-3 tall:mb-8">
      {items.map(({ label, value, icon: Icon }) => (
        <div key={label} className="glass flex min-w-0 flex-col-reverse rounded-xl border px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3">
          <dt className="flex min-w-0 items-center gap-2 text-[0.6875rem] text-muted-foreground sm:text-xs">
            <Icon className="hidden size-4 shrink-0 lg:block" aria-hidden />
            <span className="truncate">{label}</span>
          </dt>
          <dd className="text-lg leading-tight font-semibold tabular-nums sm:text-xl">
            {value ?? <span className="skeleton inline-block h-[1em] w-6 rounded align-middle" aria-label="Loading" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const GRID = "grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] sm:gap-4";
const CARD = "glass relative flex min-w-0 overflow-hidden rounded-2xl border sm:flex-col";

function ProjectSkeleton() {
  return (
    <div className={CARD} aria-hidden>
      <div className="skeleton aspect-video w-32 shrink-0 sm:w-full" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-3 py-2 sm:h-11 sm:flex-none sm:py-0">
        <div className="skeleton h-3.5 w-3/4 rounded sm:hidden" />
        <div className="skeleton h-3 w-1/2 rounded" />
      </div>
    </div>
  );
}

const ProjectCard = memo(function ProjectCard({ p, onDelete }: { p: Project; onDelete: (p: Project) => void }) {
  const live = isLive(p);
  const pct = Math.round(pctOf(p.progress, 1));
  const state =
    p.status === "done" ? `${p.ready_count} ${p.ready_count === 1 ? "clip" : "clips"} ready`
    : p.status === "failed" ? "Something went wrong"
    : `${p.stage || "Waiting to start"}${live && pct > 0 ? ` · ${pct}%` : ""}`;
  const style = `${p.settings.editing_style.replaceAll("_", " ")} · ${p.settings.caption_style.replaceAll("_", " ")}`;
  return (
    <article className={cn(CARD, "group transition-[translate,border-color] duration-200 hover:border-white/20 pointer-fine:hover:-translate-y-0.5")}>
      <Link href={`/project?id=${p.id}`} className="flex min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:block sm:flex-none">
        <div className="relative aspect-video w-32 shrink-0 self-center overflow-hidden bg-zinc-900 sm:w-full">
          {p.thumb_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.thumb_url} alt="" loading="lazy" decoding="async"
              className="h-full w-full object-cover opacity-85 transition duration-500 pointer-fine:scale-110 pointer-fine:opacity-70 pointer-fine:blur-sm pointer-fine:group-hover:scale-100 pointer-fine:group-hover:opacity-90 pointer-fine:group-hover:blur-none"
            />
          ) : (
            <div className={cn("grid h-full place-items-center", live && "skeleton")}><FileVideo className="size-6 text-muted-foreground sm:size-8" aria-hidden /></div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent max-sm:hidden" />
          <div className="absolute top-3 left-3 max-sm:hidden"><StatusBadge status={p.status} /></div>
          {p.duration ? <div className="absolute right-1.5 bottom-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[0.6875rem] tabular-nums sm:top-3 sm:right-3 sm:bottom-auto sm:text-xs">{fmtDuration(p.duration)}</div> : null}
          <div className="absolute inset-x-3 bottom-3 max-sm:hidden">
            <div className="truncate font-medium text-white">{p.name}</div>
            <div className="mt-0.5 truncate text-xs text-white/70">{state}</div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-2 pr-1 pl-3 sm:hidden">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className={cn("truncate text-xs text-muted-foreground", p.status === "failed" && "text-destructive", p.status === "done" && "text-success")}>{state}</div>
          {live && <Progress value={pct} className="h-1.5" />}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-3 pr-1.5 sm:h-11 sm:pr-1.5 sm:pl-3">
        <div className="min-w-0 flex-1 max-sm:hidden">
          {live ? <Progress value={pct} /> : <span className="block truncate text-xs text-muted-foreground capitalize">{style}</span>}
        </div>
        <button
          type="button"
          onClick={() => onDelete(p)}
          aria-label={`Delete project ${p.name}`}
          title="Delete project"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-white/5 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/10 pointer-coarse:size-10 [@media(hover:hover)]:opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </article>
  );
});

export default function Studio() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: projects, error: projectsError, mutate } = useSWR<Project[]>("/api/projects", firstFetcher, SWR_PROJECTS);
  const { data: clips, mutate: mutateClips } = useSWR<Clip[]>("/api/clips", firstFetcher, SWR_CLIPS);
  const up = useUpload();
  const { upload: u, start: startUpload, generate: queueGenerate, undoGenerate, cancel: cancelUpload, queuedSettings } = up;
  const [source, setSource] = useState<Source>("upload");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [probe, setProbe] = useState<URLProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  const [settings, setSettings] = useState<GenerationSettings>(() => queuedSettings() ?? DEFAULT_SETTINGS);
  const firstSettings = useRef(settings);
  const [styleOpen, setStyleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [hello, setHello] = useState("Welcome back");
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const resumeFor = useRef<ServerUpload | null>(null);
  const composer = useRef<HTMLElement>(null);

  useEffect(() => setHello(greeting()), []);

  const liveCount = projects?.filter(isLive).length ?? 0;
  const lastLive = useRef(0);
  useEffect(() => {
    if (liveCount < lastLive.current) void mutateClips();
    lastLive.current = liveCount;
  }, [liveCount, mutateClips]);

  const warmStyles = useCallback(() => {
    preload("/api/presets", fetcher);
    preload("/api/music", fetcher);
    preload("/api/broll", fetcher);
  }, []);

  const focusComposer = useCallback(() => {
    const el = composer.current;
    if (!el) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
    el.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    el.animate?.([{ boxShadow: "0 0 0 0 rgb(217 70 239 / .65)" }, { boxShadow: "0 0 0 14px rgb(217 70 239 / 0)" }], { duration: calm ? 1 : 900, easing: "ease-out" });
  }, []);

  const openPicker = useCallback((resume?: ServerUpload) => {
    resumeFor.current = resume ?? null;
    fileInput.current?.click();
  }, []);

  const pick = useCallback(
    (file: File, resume?: ServerUpload | null) => {
      if (!startUpload(file, resume ? { resume } : undefined)) return;
      setSource("upload");
      warmStyles();
    },
    [startUpload, warmStyles],
  );

  const useLinkInstead = useCallback(() => {
    setSource("url");
    requestAnimationFrame(() => document.getElementById("src-url")?.focus());
  }, []);

  const queued = !!u?.autoStart;
  useEffect(() => {
    if (queued && settings !== firstSettings.current) queueGenerate(settings);
  }, [queued, settings, queueGenerate]);

  const link = toLink(url);
  useEffect(() => {
    setProbe(null);
  }, [url]);

  async function checkLink() {
    if (!link) return;
    setProbing(true);
    try {
      const info = await api.probeUrl(link);
      setProbe(info);
    } catch (e) {
      toast.error("Could not inspect link", { description: (e as Error).message });
    } finally {
      setProbing(false);
    }
  }

  const uploadReady = !!u && !["error", "canceled", "finishing", "done"].includes(u.phase);
  const ready = source === "upload" ? uploadReady : source === "url" ? !!link : !!path.trim();
  const uploading = !!u && ["preparing", "uploading", "waiting", "paused"].includes(u.phase);

  const openStyle = useCallback(() => {
    warmStyles();
    setStyleOpen(true);
  }, [warmStyles]);

  async function generate() {
    if (source === "upload") {
      if (!u || !uploadReady) return;
      const now = u.phase === "uploaded";
      queueGenerate(settings);
      setStyleOpen(false);
      if (!now && !u.autoStart)
        toast.success(`${settings.clip_count} clips start when the upload finishes`, {
          description: "Keep this tab open. You can use the rest of the app meanwhile.",
          action: { label: "Undo", onClick: undoGenerate },
        });
      return;
    }
    const sStart = parseClockToSec(trimStart);
    const sEnd = parseClockToSec(trimEnd);
    setBusy(true);
    try {
      const payload =
        source === "url"
          ? { url: link ?? url.trim(), name: probe?.title, source_start: sStart, source_end: sEnd, settings }
          : { path: path.trim(), source_start: sStart, source_end: sEnd, settings };
      const p = await api.createFromLink(payload);
      void globalMutate(`/api/projects/${p.id}`, p, { revalidate: false });
      void mutate();
      toast.success("Your clips are cooking", { description: `${settings.clip_count} clips on the way.` });
      if (uploading)
        toast(`"${u.fileName}" is still uploading`, {
          description: "Cancel it if you do not need it anymore.",
          action: { label: "Cancel upload", onClick: cancelUpload },
          duration: 12000,
        });
      setStyleOpen(false);
      router.push(`/project?id=${p.id}`);
    } catch (e) {
      toast.error("Could not start", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const deleteProject = useCallback(
    (p: Project) => {
      if (!window.confirm(`Delete "${p.name}" and all its clips?`)) return;
      const without = (list?: Project[]) => (list ?? []).filter((x) => x.id !== p.id);
      mutate(
        async (list) => {
          await api.deleteProject(p.id);
          return without(list);
        },
        { optimisticData: without, rollbackOnError: true },
      )
        .then(() => mutateClips())
        .catch((e) => toast.error("Could not delete the project", { description: (e as Error).message }));
    },
    [mutate, mutateClips],
  );

  const setCount = (n: number) => setSettings((s) => ({ ...s, clip_count: Math.max(COUNT.min, Math.min(COUNT.max, n)) }));
  const count = settings.clip_count;
  const stepBtn =
    "grid size-9 place-items-center rounded-lg border border-white/10 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/10 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-10";

  return (
    <>
      <Suspense fallback={null}><NewProjectWatcher onNew={focusComposer} /></Suspense>
      <PageHeader
        eyebrow={hello}
        title={<>Hey {user?.name ?? "there"}, let&apos;s make something <span className="text-gradient">go viral</span>.</>}
        description={<span className="max-sm:hidden">Drop in a long video and get 1 to 50 vertical clips with captions, smart framing, iOS emojis and music.</span>}
      />

      <section
        ref={composer}
        aria-label="New project"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDrag(true);
          if (!u) setSource("upload");
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDrag(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDrag(false);
          const files = e.dataTransfer.files;
          if (files.length > 1) toast("One video at a time", { description: `Only "${files[0].name}" was added.` });
          if (files[0]) pick(files[0]);
        }}
        className="glass @container relative mb-4 rounded-3xl border p-4 sm:mb-6 sm:p-6"
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
          <div className="absolute -top-24 -right-24 size-72 rounded-full bg-fuchsia-500/20 blur-3xl" />
        </div>
        <div className="relative grid grid-cols-1 gap-4 @[38rem]:grid-cols-[minmax(0,1fr)_17.5rem] @[38rem]:gap-6 @[50rem]:grid-cols-[minmax(0,1fr)_18.75rem]">
          <div className="min-w-0">
            <div role="tablist" aria-label="Where the video comes from" className="mb-3 flex rounded-xl bg-white/[.04] p-1 @[24rem]:w-fit @[38rem]:mb-4 @[38rem]:w-auto @[44.5rem]:w-fit">
              {SOURCES.map(({ key, label, short, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`src-tab-${key}`}
                  aria-selected={source === key}
                  aria-controls="src-panel"
                  onClick={() => setSource(key)}
                  className={cn(
                    "relative flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2.5 @[24rem]:px-4",
                    source === key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {source === key && <motion.span layoutId="src-pill" className="absolute inset-0 rounded-lg bg-white/10 ring-1 ring-white/10" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                  <Icon className="relative size-4 shrink-0" aria-hidden />
                  <span className="relative @[24rem]:hidden @[38rem]:inline @[44.5rem]:hidden">{short}</span>
                  <span className="relative hidden @[24rem]:inline @[38rem]:hidden @[44.5rem]:inline">{label}</span>
                  {key === "upload" && source !== "upload" && uploading && <span className="relative size-1.5 rounded-full bg-primary" aria-label="Upload running" />}
                </button>
              ))}
            </div>

            <div id="src-panel" role="tabpanel" aria-labelledby={`src-tab-${source}`}>
              {source !== "upload" && u && u.phase !== "canceled" && u.phase !== "done" && (
                <div className="mb-3 rounded-xl border border-white/10 bg-white/[.03] px-3 py-2" aria-label={`Upload of ${u.fileName}`}>
                  <UploadProgress variant="line" />
                  {uploading && <p className="mt-1.5 text-[11px] text-muted-foreground">Your upload keeps going. Cancel it if you use a link instead.</p>}
                </div>
              )}
              {source === "upload" && <UploadPanel drag={drag} openPicker={openPicker} onUseLink={useLinkInstead} />}
              {source === "url" && (
                <div className="flex flex-col gap-2.5">
                  <TextSource
                    id="src-url" label="Video link" icon={Link2} type="url" value={url} onChange={setUrl} onEnter={() => link && openStyle()}
                    placeholder="Paste a video link"
                    warn={url.trim() && !link ? "That does not look like a link. It should start with https://" : null}
                    help={<>YouTube, Twitch, Vimeo, X or Google Drive. The server downloads it directly (up to 1080p).</>}
                    extraBtn={link ? (
                      <button type="button" onClick={checkLink} disabled={probing} className={FIELD_BTN}>
                        {probing ? <Loader2 className="size-3.5 animate-spin" /> : <SearchCheck className="size-3.5" />} Check link
                      </button>
                    ) : null}
                  />
                  {probe && (
                    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] p-2.5 text-xs">
                      {probe.thumbnail && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={probe.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">{probe.title}</div>
                        <div className="mt-0.5 text-muted-foreground">
                          {[probe.uploader, probe.duration ? fmtDuration(probe.duration) : null].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {source === "path" && (
                <TextSource
                  id="src-path" label="Server path" icon={FolderOpen} type="text" mono value={path} onChange={setPath} onEnter={() => path.trim() && openStyle()}
                  placeholder="/data/videos/stream.mp4"
                  help="For a file that is already on the server. Nothing is uploaded."
                />
              )}
              {source !== "upload" && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Optional segment range:</span>
                  <Input
                    value={trimStart}
                    onChange={(e) => setTrimStart(e.target.value)}
                    placeholder="Start (e.g. 12:30)"
                    className="h-8 w-32 text-xs"
                  />
                  <span>to</span>
                  <Input
                    value={trimEnd}
                    onChange={(e) => setTrimEnd(e.target.value)}
                    placeholder="End (e.g. 45:00)"
                    className="h-8 w-32 text-xs"
                  />
                </div>
              )}
            </div>
            <input
              ref={fileInput} type="file" accept={ACCEPT} hidden tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                const resume = resumeFor.current;
                resumeFor.current = null;
                if (f) pick(f, resume);
                e.target.value = "";
              }}
            />
          </div>

          <div className="flex min-w-0 flex-col justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 p-3.5 @[38rem]:gap-4 @[38rem]:p-5">
            <div>
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div id="count-label" className="text-sm text-muted-foreground">Clips to generate</div>
                  <output aria-labelledby="count-label" className="text-gradient block text-4xl leading-none font-bold tabular-nums @[38rem]:mt-1 @[38rem]:text-5xl tall:@[38rem]:text-6xl">{count}</output>
                </div>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setCount(count - 1)} disabled={count <= COUNT.min} aria-label="One clip less" className={stepBtn}><Minus className="size-4" /></button>
                  <button type="button" onClick={() => setCount(count + 1)} disabled={count >= COUNT.max} aria-label="One clip more" className={stepBtn}><Plus className="size-4" /></button>
                </div>
              </div>
              <Slider min={COUNT.min} max={COUNT.max} step={1} value={[count]} onValueChange={([v]) => setCount(v)} className="py-3 pointer-coarse:py-[1.125rem]" />
              <div className="grid grid-cols-5 gap-1.5">
                {COUNT.presets.map((n) => (
                  <button
                    key={n} type="button" onClick={() => setCount(n)} aria-pressed={count === n} aria-label={`${n} clips`}
                    className={cn(
                      "h-8 rounded-lg border text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-white/10 pointer-coarse:h-10 pointer-coarse:text-sm",
                      count === n ? "border-primary/60 bg-primary/15 text-foreground" : "border-white/10 text-muted-foreground hover:bg-white/5",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <button
                type="button" disabled={!ready} onClick={openStyle} onPointerEnter={warmStyles} onFocus={warmStyles}
                className="bg-brand group flex h-12 w-full items-center justify-center gap-2 rounded-xl font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition outline-none hover:brightness-110 focus-visible:ring-4 focus-visible:ring-primary/40 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
              >
                <Wand2 className="size-4" aria-hidden /> {source === "upload" && queued ? "Change style" : "Choose style"}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden />
              </button>
              {!ready && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  {source === "upload" ? (u ? "Sort out the upload first" : "Add a video first") : source === "url" ? "Paste a video link first" : "Enter the path of a video first"}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <Stats projects={projects} clips={clips} />

      <Dialog open={styleOpen} onOpenChange={setStyleOpen}>
        <DialogContent className="sm:max-w-4xl 2xl:max-w-5xl">
          <DialogHeader className="sm:flex-row sm:items-baseline sm:gap-3">
            <DialogTitle className="flex shrink-0 items-center gap-2"><Sparkles className="size-5 text-primary" aria-hidden /> Pick your style</DialogTitle>
            <DialogDescription className="min-w-0 max-sm:sr-only sm:truncate">Used for every clip in this run. You can override individual clips later.</DialogDescription>
          </DialogHeader>
          <DialogBody><StyleSelector value={settings} onChange={setSettings} /></DialogBody>
          <DialogFooter className="flex-col gap-2.5 sm:gap-5">
            {source === "upload" && u && (
              <div className="min-w-0 sm:mr-auto sm:max-w-md sm:flex-1">
                <UploadProgress variant="line" />
                <QueuedNote compact className="mt-1" />
              </div>
            )}
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={() => setStyleOpen(false)} className="max-sm:h-11 pointer-coarse:h-11">Back</Button>
              {source === "upload" && queued ? (
                <Button size="lg" onClick={() => setStyleOpen(false)} className="bg-brand flex-1 text-white hover:brightness-110 sm:flex-none"><Check /> Done</Button>
              ) : (
                <Button size="lg" onClick={generate} disabled={busy || !ready} className="bg-brand flex-1 text-white hover:brightness-110 sm:flex-none">
                  {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate {count} {count === 1 ? "clip" : "clips"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Your projects</h2>
        {!!clips?.length && (
          <Link href="/library" className="inline-flex shrink-0 items-center gap-1 rounded text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:py-2">
            All clips <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {!projects && projectsError ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center">
          <div className="font-medium">Could not load your projects</div>
          <p className="mt-1 text-sm text-muted-foreground">{(projectsError as Error).message || "Check your connection."} Trying again by itself.</p>
          <Button variant="outline" className="mt-4" onClick={() => mutate()}>Try now</Button>
        </div>
      ) : !projects ? (
        <div className={GRID}>{[0, 1, 2].map((i) => <ProjectSkeleton key={i} />)}</div>
      ) : projects.length === 0 ? (
        <div className="glass rounded-3xl border border-dashed px-6 py-10 text-center sm:py-12">
          <Clapperboard className="mx-auto mb-3 size-8 text-primary" aria-hidden />
          <div className="font-medium">No projects yet</div>
          <p className="mt-1 text-sm text-muted-foreground">Your first run will show up here.</p>
        </div>
      ) : (
        <div className={GRID}>{projects.map((p) => <ProjectCard key={p.id} p={p} onDelete={deleteProject} />)}</div>
      )}
    </>
  );
}
