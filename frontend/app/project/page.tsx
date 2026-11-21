"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR, { type SWRConfiguration } from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowLeft, Check, CheckSquare, Clock, Download, HardDrive, Loader2, Palette, Plus, RotateCcw, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2, TriangleAlert, Wand2, WifiOff,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { aspectClass, CLIP_GRID, ClipCard, ClipGridSkeleton } from "@/components/clip-card";
import { ClipStudio, useClipStudio } from "@/components/clip-studio";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ApiError, api, fetcher, type Clip, type GenerationSettings, type MusicTrack, type Presets, type Project, type TranscriptResponse } from "@/lib/api";
import { cn, fmtBytes, fmtDuration } from "@/lib/utils";

const isLive = (p?: Project) => p?.status === "queued" || p?.status === "processing";
const isBusy = (c: Clip) => c.status === "pending" || c.status === "rendering";
const PROJECT_EVERY = 1500;
const CLIPS_EVERY = 6000;

const retrySoon: NonNullable<SWRConfiguration["onErrorRetry"]> = (err, _key, _config, revalidate, { retryCount }) => {
  if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  setTimeout(() => revalidate({ retryCount }), Math.min(1500 * retryCount, 6000));
};

const runKey = (id: number) => `autoclip:run:${id}`;
type Run = { start: number; p: number };

function readRun(id: number): Run | null {
  try {
    const r = JSON.parse(localStorage.getItem(runKey(id)) ?? "null");
    return r && typeof r.start === "number" && typeof r.p === "number" ? r : null;
  } catch {
    return null;
  }
}
function writeRun(id: number, run: Run | null) {
  try {
    if (run) localStorage.setItem(runKey(id), JSON.stringify(run));
    else localStorage.removeItem(runKey(id));
  } catch {}
}
function parseTime(iso: string) {
  const s = iso.replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

function useRunStart(project: Project | undefined) {
  const [start, setStart] = useState<number | null>(null);
  const id = project?.id;
  const live = isLive(project);
  const progress = project?.progress ?? 0;
  const createdAt = project?.created_at;
  const hadClips = (project?.clip_count ?? 0) > 0;
  const serverStart = (project as (Project & { started_at?: string | null }) | undefined)?.started_at;

  useEffect(() => {
    if (id == null) return;
    if (!live) {
      writeRun(id, null);
      setStart(null);
      return;
    }
    const now = Date.now();
    const fromServer = serverStart ? parseTime(serverStart) : NaN;
    if (!Number.isNaN(fromServer)) return setStart(Math.min(fromServer, now));

    let run = readRun(id);
    if (run && (progress + 0.05 < run.p || run.start > now || now - run.start > 48 * 3600e3)) run = null;
    if (!run) {
      const created = createdAt ? parseTime(createdAt) : NaN;
      const underWay = progress >= 0.02 && !(hadClips && progress < 0.68);
      const usable = !Number.isNaN(created) && created <= now && now - created < 12 * 3600e3;
      run = { start: underWay && usable ? created : now, p: progress };
    } else if (progress > run.p) {
      run = { start: run.start, p: progress };
    }
    writeRun(id, run);
    setStart(run.start);
  }, [id, live, progress, createdAt, hadClips, serverStart]);

  return live ? start : null;
}

function fmtClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="tabular-nums">{fmtClock((now - since) / 1000)}</span>;
}

const STEPS = [
  { from: 0, label: "Get video" },
  { from: 0.16, label: "Transcribe" },
  { from: 0.62, label: "Pick moments" },
  { from: 0.7, label: "Make clips" },
];

function LiveCard({ project, since, offline }: { project: Project; since: number | null; offline: boolean }) {
  const queued = project.status === "queued";
  const pct = Math.max(0, Math.min(100, Math.round(project.progress * 100)));
  const stage = project.stage?.trim() || (queued ? "Waiting to start" : "Working on it");
  const current = queued && project.progress <= 0 ? -1 : STEPS.reduce((at, s, i) => (project.progress >= s.from ? i : at), 0);

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} aria-label="Progress" className="glass mb-6 rounded-3xl border p-4 sm:mb-8 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge status={project.status} />
        <p className="order-last line-clamp-2 min-w-0 basis-full text-sm wrap-anywhere sm:order-none sm:line-clamp-1 sm:flex-1 sm:basis-0" title={stage}>{stage}</p>
        <span className="text-gradient ml-auto shrink-0 text-2xl leading-none font-semibold tabular-nums">{pct}%</span>
      </div>
      <div role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%, ${stage}`} className="mt-3">
        <Progress value={Math.max(pct, 1.5)} className="h-2.5" />
      </div>
      <ol className="mt-4 grid grid-cols-4 gap-1 sm:gap-2">
        {STEPS.map((s, i) => (
          <li key={s.label} aria-current={i === current ? "step" : undefined} className={cn("flex min-w-0 flex-col items-center gap-1 text-center text-[0.6875rem] leading-tight sm:flex-row sm:gap-2 sm:text-left sm:text-xs", i <= current ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem] font-medium", i < current ? "bg-emerald-500 text-white" : i === current ? "bg-brand text-white" : "bg-white/10")}>
              {i < current ? <Check className="size-3" /> : i + 1}
            </span>
            <span className="max-w-full text-balance wrap-anywhere">{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground">
        {since != null && (
          <span className="flex shrink-0 items-center gap-1.5 text-foreground"><Clock className="size-3.5 text-primary" /><ElapsedClock since={since} /> so far</span>
        )}
        <span className="min-w-0">You can leave this page. The work carries on, and your clips show up below one by one.</span>
      </div>
      {offline && (
        <p role="status" className="mt-3 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <WifiOff className="size-3.5 shrink-0" /> Lost the connection for a moment. Trying again. Your video is still being worked on.
        </p>
      )}
    </motion.section>
  );
}

function FailedCard({ project, retrying, onRetry }: { project: Project; retrying: boolean; onRetry: () => void }) {
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} aria-label="Something went wrong" className="mb-6 rounded-3xl border border-destructive/30 bg-destructive/[.07] p-4 sm:mb-8 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive"><TriangleAlert className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">This video could not be finished</h2>
          <p className="mt-1 text-sm text-muted-foreground">Nothing was lost. Try again, or pick other settings with Re-style.</p>
        </div>
      </div>
      {project.error && (
        <p className="mt-4 max-h-40 overflow-y-auto rounded-lg bg-black/25 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-destructive">{project.error}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button className="pointer-coarse:h-11 max-sm:flex-1" disabled={retrying} onClick={onRetry}>
          {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />} Try again
        </Button>
        <Button asChild variant="ghost" className="pointer-coarse:h-11 max-sm:flex-1"><Link href="/">Back to Studio</Link></Button>
      </div>
    </motion.section>
  );
}

function WaitingWall({ count, ratio }: { count: number; ratio?: string }) {
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">Your clips will appear here as each one is made.</p>
      <div aria-hidden className={cn(CLIP_GRID, "max-sm:[&>*:nth-child(n+5)]:hidden max-xl:[&>*:nth-child(n+9)]:hidden")}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className={cn("grid place-items-center rounded-2xl border border-dashed border-white/10 bg-white/[.02] text-sm text-muted-foreground/50", aspectClass(ratio))}>
            #{i + 1}
          </div>
        ))}
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-5 h-5 w-20 rounded" />
      <div className="skeleton mb-3 h-8 w-2/3 max-w-md rounded-lg" />
      <div className="skeleton mb-8 h-4 w-1/2 max-w-xs rounded" />
      <ClipGridSkeleton count={10} />
    </div>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="glass max-w-xl rounded-3xl border p-6 sm:p-8">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm wrap-anywhere text-muted-foreground">{text}</p>
      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];
type SortKey = "rank" | "score" | "duration";

function ProjectView() {
  const id = useSearchParams().get("id");
  const [every, setEvery] = useState({ project: 0, clips: 0 });
  const { data: project, error: projectError, mutate: mutateProject } = useSWR<Project>(id ? `/api/projects/${id}` : null, fetcher, {
    refreshInterval: every.project,
    dedupingInterval: 1000,
    onErrorRetry: retrySoon,
  });
  const { data: clips, error: clipsError, mutate: mutateClips } = useSWR<Clip[]>(id ? `/api/projects/${id}/clips` : null, fetcher, {
    refreshInterval: every.clips,
    onErrorRetry: retrySoon,
  });
  const live = isLive(project);
  const rendering = live && (project?.progress ?? 0) >= 0.68;
  const busy = !!clips?.some(isBusy);
  const wantProject = live ? PROJECT_EVERY : 0;
  const wantClips = rendering || busy ? CLIPS_EVERY : 0;
  useEffect(() => {
    setEvery((e) => (e.project === wantProject && e.clips === wantClips ? e : { project: wantProject, clips: wantClips }));
  }, [wantProject, wantClips]);

  const signal = project ? `${project.id}|${project.status}|${project.clip_count}|${project.ready_count}` : null;
  const lastSignal = useRef<string | null>(null);
  useEffect(() => {
    if (signal == null) return;
    if (lastSignal.current != null && lastSignal.current !== signal) void mutateClips();
    lastSignal.current = signal;
  }, [signal, mutateClips]);

  useEffect(() => {
    if (busy && !live) void mutateProject();
  }, [busy, live, mutateProject]);

  const since = useRunStart(project);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("rank");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [restyle, setRestyle] = useState<GenerationSettings | null>(null);
  const [restyleMode, setRestyleMode] = useState<"restyle" | "rescore">("restyle");
  const [starting, setStarting] = useState(false);

  // Batch FX / Music modal
  const { data: presets } = useSWR<Presets>("/api/presets", fetcher, { revalidateOnFocus: false });
  const { data: music } = useSWR<MusicTrack[]>("/api/music", fetcher);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchEffect, setBatchEffect] = useState("");
  const [batchSpeed, setBatchSpeed] = useState("");
  const [batchCaption, setBatchCaption] = useState("");
  const [batchCaptionColor, setBatchCaptionColor] = useState("");
  const [batchHookTheme, setBatchHookTheme] = useState("");
  const [batchMusic, setBatchMusic] = useState("__keep__");
  const [batchSilences, setBatchSilences] = useState("");

  // Manual clip modal
  const [manualOpen, setManualOpen] = useState(false);
  const [trData, setTrData] = useState<TranscriptResponse | null>(null);
  const [trQuery, setTrQuery] = useState("");
  const [mStart, setMStart] = useState(0);
  const [mEnd, setMEnd] = useState(20);
  const [mTitle, setMTitle] = useState("");
  const [mSnap, setMSnap] = useState(true);
  const [mBusy, setMBusy] = useState(false);

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: 0, pending: 0, approved: 0, rejected: 0 };
    for (const c of clips ?? []) {
      n.all++;
      n[c.review_status]++;
    }
    return n;
  }, [clips]);

  const shown = useMemo(() => {
    const base = (clips ?? []).filter((c) => filter === "all" || c.review_status === filter);
    if (sort === "score") return [...base].sort((a, b) => b.score - a.score);
    if (sort === "duration") return [...base].sort((a, b) => b.duration - a.duration);
    return base;
  }, [clips, filter, sort]);

  const studio = useClipStudio(clips, shown);
  const updateClip = useCallback((c: Clip) => {
    if (isBusy(c) && !readRun(c.project_id)) writeRun(c.project_id, { start: Date.now(), p: 0 });
    void mutateClips((list) => list?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });
  }, [mutateClips]);

  const deleteClipFromList = useCallback((cid: number) => {
    void mutateClips((list) => list?.filter((x) => x.id !== cid), { revalidate: false });
  }, [mutateClips]);

  const toggleSelect = useCallback((cid: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }, []);

  async function runBulk(action: "approve" | "reject" | "delete" | "rerender") {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (action === "delete" && !window.confirm(`Delete ${ids.length} selected clip(s)?`)) return;
    setBulkBusy(true);
    try {
      await api.bulkClips(ids, action);
      setSelected(new Set());
      setSelectMode(false);
      await mutateClips();
      await mutateProject();
      toast.success(`Updated ${ids.length} clip(s)`);
    } catch (e) {
      toast.error("Bulk action failed", { description: (e as Error).message });
    } finally {
      setBulkBusy(false);
    }
  }

  async function submitBatchEdit(e: React.FormEvent) {
    e.preventDefault();
    const ids = Array.from(selected);
    if (!ids.length) return;
    const overrides: Record<string, unknown> = {};
    if (batchEffect) overrides.video_effect = batchEffect;
    if (batchSpeed) overrides.playback_speed = Number(batchSpeed);
    if (batchCaption) overrides.caption_style = batchCaption;
    if (batchCaptionColor) overrides.caption_color = batchCaptionColor;
    if (batchHookTheme) overrides.hook_card_style = batchHookTheme;
    if (batchSilences) overrides.remove_silences = batchSilences === "true";
    const clear_music = batchMusic === "__clear__";
    const music_track_id = !clear_music && batchMusic !== "__keep__" ? Number(batchMusic) : undefined;
    if (!Object.keys(overrides).length && !clear_music && music_track_id == null) {
      return void toast("Pick at least one FX, speed, caption, hook, or music change to apply");
    }
    setBulkBusy(true);
    try {
      await api.bulkClips(ids, "apply", { overrides, music_track_id, clear_music, rerender: true });
      setBatchOpen(false);
      setBatchEffect("");
      setBatchSpeed("");
      setBatchCaption("");
      setBatchCaptionColor("");
      setBatchHookTheme("");
      setBatchMusic("__keep__");
      setBatchSilences("");
      setSelected(new Set());
      setSelectMode(false);
      await mutateClips();
      await mutateProject();
      toast.success(`Applying edits & re-rendering ${ids.length} clip(s)`);
    } catch (err) {
      toast.error("Batch update failed", { description: (err as Error).message });
    } finally {
      setBulkBusy(false);
    }
  }

  async function openManualDialog() {
    setManualOpen(true);
    if (!trData && project) {
      try {
        setTrData(await api.transcript(project.id));
      } catch {
        setTrData({ language: "", sentences: [], words: [] });
      }
    }
  }

  async function submitManualClip(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setMBusy(true);
    try {
      const c = await api.createManualClip(project.id, { start: mStart, end: mEnd, title: mTitle || undefined, snap_speech: mSnap });
      await mutateClips((list) => (list ? [...list, c] : [c]), { revalidate: true });
      await mutateProject();
      setManualOpen(false);
      setMTitle("");
      toast.success("Manual clip queued for rendering");
    } catch (e) {
      toast.error("Could not create clip", { description: (e as Error).message });
    } finally {
      setMBusy(false);
    }
  }

  async function pruneSource() {
    if (!project) return;
    if (!window.confirm("Delete the raw source video file from disk? Rendered clips stay safe, but you won't be able to re-trim or re-style them.")) return;
    try {
      const res = await api.pruneSource(project.id);
      await mutateProject();
      toast.success(`Freed ${fmtBytes(res.freed_bytes)} from storage`);
    } catch (e) {
      toast.error("Could not remove source video", { description: (e as Error).message });
    }
  }

  if (!id) {
    return (
      <Notice title="No project picked" text="Open a project from the Studio page.">
        <Button asChild><Link href="/">Go to Studio</Link></Button>
      </Notice>
    );
  }
  if (!project) {
    if (!projectError) return <PageSkeleton />;
    const gone = projectError instanceof ApiError && projectError.status === 404;
    return (
      <Notice
        title={gone ? "This project is not here any more" : "Could not load this project"}
        text={gone ? "It may have been deleted." : `Check your connection and try again. (${(projectError as Error).message || "No answer from the server"})`}
      >
        {!gone && <Button variant="outline" onClick={() => mutateProject()}><RotateCcw /> Try again</Button>}
        <Button asChild variant={gone ? "default" : "ghost"}><Link href="/">Back to Studio</Link></Button>
      </Notice>
    );
  }

  const readyCount = clips?.filter((c) => c.status === "ready").length ?? 0;
  const approvedCount = clips?.filter((c) => c.review_status === "approved" && c.status === "ready").length ?? 0;
  const styleName = (s?: string) => (s ?? "").replaceAll("_", " ");
  const about = [
    project.duration != null && `${fmtDuration(project.duration)} source`,
    styleName(project.settings.editing_style),
    project.settings.caption_style && `${styleName(project.settings.caption_style)} captions`,
    project.settings.video_effect && project.settings.video_effect !== "none" && `${styleName(project.settings.video_effect)} FX`,
    project.settings.playback_speed && project.settings.playback_speed !== 1 && `${project.settings.playback_speed}x speed`,
    project.settings.aspect_ratio,
  ].filter(Boolean).join(" · ");

  async function start(settings?: GenerationSettings, mode: "rescore" | "restyle" = "rescore") {
    setStarting(true);
    try {
      const p = await api.regenerate(project!.id, settings, mode);
      writeRun(p.id, { start: Date.now(), p: 0 });
      await mutateProject(p, { revalidate: false });
      if (mode === "restyle") await mutateClips();
      setRestyle(null);
      setFilter("all");
      toast.success(mode === "restyle" ? "Re-rendering clips with new look" : "Making your clips again", {
        description: mode === "restyle" ? "Your edits, approvals, and posted marks are kept." : "The transcript is reused, so this is faster than the first time.",
      });
    } catch (e) {
      toast.error("Could not start", { description: (e as Error).message });
    } finally {
      setStarting(false);
    }
  }

  const filteredSentences = (trData?.sentences ?? []).filter(
    (s) => !trQuery.trim() || s.text.toLowerCase().includes(trQuery.trim().toLowerCase()),
  );

  return (
    <>
      <Link href="/" className="mb-3 inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-10 sm:mb-4">
        <ArrowLeft className="size-4" /> Studio
      </Link>
      <PageHeader
        title={project.name}
        description={<span className="capitalize">{about}</span>}
        actions={
          <>
            {!project.source_deleted && project.status === "done" && (
              <Button variant="outline" className="pointer-coarse:h-11" onClick={openManualDialog}><Plus /> Add clip</Button>
            )}
            <Button variant="outline" className="pointer-coarse:h-11" disabled={live || project.source_deleted} onClick={() => {
              setRestyleMode(counts.all > 0 ? "restyle" : "rescore");
              setRestyle(project.settings);
            }}>
              <Palette /> Re-style
            </Button>
            {readyCount > 0 ? (
              <Button variant="outline" className="pointer-coarse:h-11" asChild>
                <a
                  download
                  href={api.exportZipUrl(project.id, approvedCount ? "approved" : "all")}
                  onClick={() => toast("Packing your clips into one ZIP file", { description: "Includes MP4s, platform captions, and .SRT subtitles." })}
                >
                  <Download /> {approvedCount ? `Download ${approvedCount} approved` : "Download all"}
                </a>
              </Button>
            ) : (
              <Button variant="outline" className="pointer-coarse:h-11" disabled title="There are no finished clips yet"><Download /> Download all</Button>
            )}
          </>
        }
      />

      {live && <LiveCard project={project} since={since} offline={!!projectError} />}
      {project.status === "failed" && <FailedCard project={project} retrying={starting} onRetry={() => start(undefined, "rescore")} />}

      {!live && project.status === "done" && !project.source_deleted && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[.02] px-4 py-2.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><HardDrive className="size-3.5 text-primary" /> Raw source video is kept on disk so you can re-trim or re-style clips.</span>
          <button type="button" onClick={pruneSource} className="font-medium text-foreground hover:text-destructive hover:underline">
            Delete raw source to free space
          </button>
        </div>
      )}

      {counts.all > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 sm:mb-5">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1 sm:gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "relative min-w-0 rounded-full px-2.5 py-1.5 text-[0.8125rem] whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[.97] sm:px-4 sm:text-sm pointer-coarse:min-h-10",
                  filter === f.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filter === f.key && <motion.span layoutId="clip-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" transition={{ duration: 0.2 }} />}
                <span className="relative">{f.label} <span className="text-muted-foreground tabular-nums">{counts[f.key]}</span></span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select
              aria-label="Sort clips"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-9 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="rank">Sort: Rank</option>
              <option value="score">Sort: Highest score</option>
              <option value="duration">Sort: Longest</option>
            </select>
            <Button
              variant={selectMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelected(new Set());
              }}
              className="h-9 text-xs"
            >
              <CheckSquare className="size-3.5" /> {selectMode ? "Done" : "Select"}
            </Button>
          </div>
        </div>
      )}

      {selectMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-xs">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set(shown.map((c) => c.id)))}>Select all ({shown.length})</Button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={!selected.size || bulkBusy} onClick={() => runBulk("approve")}><ThumbsUp className="size-3.5" /> Approve</Button>
            <Button size="sm" variant="secondary" disabled={!selected.size || bulkBusy} onClick={() => runBulk("reject")}><ThumbsDown className="size-3.5" /> Reject</Button>
            <Button size="sm" variant="default" disabled={!selected.size || bulkBusy || project.source_deleted} onClick={() => setBatchOpen(true)}><Wand2 className="size-3.5" /> Batch FX / Music</Button>
            <Button size="sm" variant="secondary" disabled={!selected.size || bulkBusy || project.source_deleted} onClick={() => runBulk("rerender")}><RotateCcw className="size-3.5" /> Re-render</Button>
            <Button size="sm" variant="destructive" disabled={!selected.size || bulkBusy} onClick={() => runBulk("delete")}><Trash2 className="size-3.5" /> Delete</Button>
          </div>
        </div>
      )}

      {shown.length > 0 ? (
        <div className={CLIP_GRID}>
          {shown.map((c, i) => (
            <ClipCard
              key={c.id}
              clip={c}
              index={i}
              ratio={project.settings.aspect_ratio}
              selectable={selectMode}
              selected={selected.has(c.id)}
              onToggleSelect={toggleSelect}
              onChange={updateClip}
              onOpen={(cid) => studio.open(cid, "publish")}
              onEdit={(cid) => studio.open(cid, "edit")}
            />
          ))}
        </div>
      ) : counts.all > 0 ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:p-12">
          No clips in this group.
          <div className="mt-3"><Button variant="outline" size="sm" className="pointer-coarse:h-10" onClick={() => setFilter("all")}>Show all {counts.all}</Button></div>
        </div>
      ) : live ? (
        <WaitingWall count={Math.max(4, Math.min(Number(project.settings.clip_count) || 10, 12))} ratio={project.settings.aspect_ratio} />
      ) : !clips ? (
        clipsError ? (
          <Notice title="Could not load the clips" text="Check your connection and try again.">
            <Button variant="outline" onClick={() => mutateClips()}><RotateCcw /> Try again</Button>
          </Notice>
        ) : (
          <ClipGridSkeleton count={10} ratio={project.settings.aspect_ratio} />
        )
      ) : project.status !== "failed" ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:p-12">
          <Sparkles className="mx-auto mb-2 size-6 text-primary" />
          No clips here yet.
        </div>
      ) : null}

      <ClipStudio
        clips={studio.clips}
        index={studio.index}
        initialTab={studio.tab}
        projectAspect={project.settings.aspect_ratio}
        projectSettings={project.settings}
        onOpen={studio.open}
        onClose={studio.close}
        onChange={updateClip}
        onDelete={deleteClipFromList}
      />

      {/* Re-style dialog */}
      <Dialog open={!!restyle} onOpenChange={(o) => !o && !starting && setRestyle(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Re-style this project</DialogTitle>
            <DialogDescription>Pick a new look and decide whether to keep your existing clips or re-pick moments.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {counts.all > 0 && (
              <div className="mb-5 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setRestyleMode("restyle")}
                  className={cn(
                    "rounded-xl border p-3 text-left text-xs transition",
                    restyleMode === "restyle" ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-white/10 hover:bg-white/5",
                  )}
                >
                  <div className="font-semibold text-foreground">Keep existing clips &amp; edits</div>
                  <p className="mt-0.5 text-muted-foreground">Re-renders all {counts.all} clips with the new effects, captions, layout, music &amp; polish while keeping titles, approvals, and posted badges.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setRestyleMode("rescore")}
                  className={cn(
                    "rounded-xl border p-3 text-left text-xs transition",
                    restyleMode === "rescore" ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-white/10 hover:bg-white/5",
                  )}
                >
                  <div className="font-semibold text-foreground">Re-pick moments from scratch</div>
                  <p className="mt-0.5 text-muted-foreground">Re-runs highlight selection ({restyle?.clip_count ?? 20} clips, {restyle?.min_duration}–{restyle?.max_duration}s). Replaces current clips.</p>
                </button>
              </div>
            )}
            {restyle && <StyleSelector value={restyle} onChange={setRestyle} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" className="pointer-coarse:h-11" disabled={starting} onClick={() => setRestyle(null)}>Cancel</Button>
            <Button className="bg-brand text-white pointer-coarse:h-11" disabled={starting || !restyle} onClick={() => restyle && start(restyle, restyleMode)}>
              {starting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {starting ? "Starting…" : restyleMode === "restyle" ? `Re-render ${counts.all} clips` : `Re-generate ${restyle?.clip_count ?? ""} clips`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch FX / Music modal */}
      <Dialog open={batchOpen} onOpenChange={(o) => !o && !bulkBusy && setBatchOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {selected.size} selected clip{selected.size === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>Apply a trending effect, speed adjustment, caption style, or background music track to the selected clips and re-render them.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form id="batch-edit-form" onSubmit={submitBatchEdit} className="grid gap-3 text-xs">
              <label className="text-muted-foreground">Trending video effect
                <select value={batchEffect} onChange={(e) => setBatchEffect(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  {presets?.video_effects?.map((fx) => (
                    <option key={fx.key} value={fx.key}>{fx.name}{fx.badge ? ` (${fx.badge})` : ""}</option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground">Clip pace (speed)
                <select value={batchSpeed} onChange={(e) => setBatchSpeed(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  {(presets?.playback_speeds ?? [
                    { value: 0.9, label: "0.9x Slow" },
                    { value: 1.0, label: "1.0x Normal" },
                    { value: 1.05, label: "1.05x Tight" },
                    { value: 1.1, label: "1.1x Viral" },
                    { value: 1.15, label: "1.15x Fast" },
                    { value: 1.25, label: "1.25x Rapid" },
                  ]).map((sp) => (
                    <option key={sp.value} value={String(sp.value)}>{sp.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground">Background music
                <select value={batchMusic} onChange={(e) => setBatchMusic(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="__keep__">Keep existing music</option>
                  <option value="__clear__">Remove music</option>
                  {music?.map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.name}{m.bpm ? ` · ${Math.round(m.bpm)} BPM` : ""}</option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground">Caption style
                <select value={batchCaption} onChange={(e) => setBatchCaption(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  {presets?.caption_styles.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                  <option value="none">No captions</option>
                </select>
              </label>
              <label className="text-muted-foreground">Caption highlight color
                <select value={batchCaptionColor} onChange={(e) => setBatchCaptionColor(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  {(presets?.caption_colors ?? []).filter((c) => c.key).map((c) => (
                    <option key={c.key} value={c.key}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground">Hook card theme
                <select value={batchHookTheme} onChange={(e) => setBatchHookTheme(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  {(presets?.hook_card_styles ?? [
                    { key: "light", name: "Light pill" },
                    { key: "dark", name: "Dark pill" },
                    { key: "accent", name: "Brand gradient" },
                    { key: "glass", name: "Frosted glass" },
                    { key: "viral_yellow", name: "Viral Gold Banner" },
                    { key: "breaking_red", name: "Breaking Alert" },
                  ]).map((h) => (
                    <option key={h.key} value={h.key}>{h.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-muted-foreground">Auto jump-cut awkward silences
                <select value={batchSilences} onChange={(e) => setBatchSilences(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-xs text-foreground">
                  <option value="">Keep existing</option>
                  <option value="true">Turn On</option>
                  <option value="false">Turn Off</option>
                </select>
              </label>
            </form>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={bulkBusy} onClick={() => setBatchOpen(false)}>Cancel</Button>
            <Button type="submit" form="batch-edit-form" className="bg-brand text-white" disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="animate-spin" /> : <Wand2 />} Apply &amp; re-render {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Clip Creator dialog */}
      <Dialog open={manualOpen} onOpenChange={(o) => !o && !mBusy && setManualOpen(false)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create manual clip</DialogTitle>
            <DialogDescription>Pick any timestamp range or click a sentence from the transcript below.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form id="manual-clip-form" onSubmit={submitManualClip} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted-foreground">Start (seconds)
                  <Input type="number" step="0.5" min={0} max={project.duration ?? undefined} value={mStart} onChange={(e) => setMStart(Number(e.target.value))} className="mt-1" required />
                </label>
                <label className="text-xs text-muted-foreground">End (seconds)
                  <Input type="number" step="0.5" min={1} max={project.duration ?? undefined} value={mEnd} onChange={(e) => setMEnd(Number(e.target.value))} className="mt-1" required />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={mSnap} onChange={(e) => setMSnap(e.target.checked)} className="size-4 accent-primary" />
                Snap clip end cleanly to when the speaker finishes their sentence / stops talking
              </label>
              <label className="text-xs text-muted-foreground">Title / Hook (optional)
                <Input value={mTitle} onChange={(e) => setMTitle(e.target.value)} placeholder="Leave empty to auto-fill from speech" className="mt-1" />
              </label>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">Search transcript to set range</span>
                  <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[.03] px-2.5">
                    <Search className="size-3.5 text-muted-foreground" />
                    <input
                      value={trQuery}
                      onChange={(e) => setTrQuery(e.target.value)}
                      placeholder="Filter spoken words…"
                      className="h-8 bg-transparent text-xs outline-none"
                    />
                  </div>
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                  {!trData ? (
                    <p className="p-3 text-xs text-muted-foreground">Loading transcript…</p>
                  ) : filteredSentences.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground">No transcript sentences found.</p>
                  ) : (
                    filteredSentences.slice(0, 120).map((s, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setMStart(Math.max(0, Number((s.start - 0.15).toFixed(1))));
                          setMEnd(Math.min(project.duration || s.end + 25, Number((s.start + 25).toFixed(1))));
                          if (!mTitle) setMTitle(s.text.slice(0, 75));
                        }}
                        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-white/10"
                      >
                        <span className="shrink-0 font-mono text-[11px] text-primary tabular-nums">{fmtDuration(s.start)}</span>
                        <span className="text-foreground/90">{s.text}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </form>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={mBusy} onClick={() => setManualOpen(false)}>Cancel</Button>
            <Button type="submit" form="manual-clip-form" className="bg-brand text-white" disabled={mBusy || mEnd <= mStart + 1}>
              {mBusy ? <Loader2 className="animate-spin" /> : <Plus />} Render clip ({Math.max(0, mEnd - mStart).toFixed(1)}s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProjectView />
    </Suspense>
  );
}
