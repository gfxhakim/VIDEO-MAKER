"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR, { type SWRConfiguration } from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, Check, Clock, Download, Loader2, Palette, RotateCcw, Sparkles, TriangleAlert, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { CLIP_GRID, ClipCard, ClipGridSkeleton } from "@/components/clip-card";
import { ClipStudio, useClipStudio } from "@/components/clip-studio";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ApiError, api, fetcher, type Clip, type GenerationSettings, type Project } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

/* ------------------------------------------------------------------ polling */

const isLive = (p?: Project) => p?.status === "queued" || p?.status === "processing";
const isBusy = (c: Clip) => c.status === "pending" || c.status === "rendering";
const PROJECT_EVERY = 1500;
const CLIPS_EVERY = 6000;

/**
 * One dropped request must not freeze the page: SWR stops polling while a key is in error and its
 * own retry backs off for longer and longer. Retry soon instead, and keep doing it.
 */
const retrySoon: NonNullable<SWRConfiguration["onErrorRetry"]> = (err, _key, _config, revalidate, { retryCount }) => {
  if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return; // nothing to wait for
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // SWR checks again when the tab is back
  setTimeout(() => revalidate({ retryCount }), Math.min(1500 * retryCount, 6000));
};

/* ------------------------------------------------------------------ elapsed time */

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
  } catch {
    /* private mode: the clock just restarts on reload */
  }
}
/** The API sends UTC, sometimes without a zone and with microseconds. */
function parseTime(iso: string) {
  const s = iso.replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

/**
 * When the current run started, for the "so far" clock.
 * The API does not say (see `started_at` below, used the day it does), so this browser remembers when it
 * first saw the run and keeps that across reloads. Progress going backwards means a new run began.
 */
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
      // First sight of this run. If it is already under way, the project's creation time is the best guess,
      // unless this is a re-run of an older project (it still has its clips from before).
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

/** Ticks on its own, so the rest of the page does not re-render every second. */
function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="tabular-nums">{fmtClock((now - since) / 1000)}</span>;
}

/* ------------------------------------------------------------------ progress card */

// The pipeline moves the bar through these marks; the text beside the bar comes from the server as is.
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
        {/* whatever the server says, however long: two lines at most on a phone, one line beside the badge from there up */}
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

/** Quiet placeholders while the first clips are being made. No shimmer: this can stay on screen for many minutes. */
function WaitingWall({ count }: { count: number }) {
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">Your clips will appear here as each one is made.</p>
      <div aria-hidden className={cn(CLIP_GRID, "max-sm:[&>*:nth-child(n+5)]:hidden max-xl:[&>*:nth-child(n+9)]:hidden")}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="grid aspect-[9/16] place-items-center rounded-2xl border border-dashed border-white/10 bg-white/[.02] text-sm text-muted-foreground/50">
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

/* ------------------------------------------------------------------ page */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

function ProjectView() {
  const id = useSearchParams().get("id");
  // How often to poll, as plain numbers kept in state. SWR (2.5) only looks at `refreshInterval` when its
  // identity changes: an inline function restarts the timer on every render, and a stable function that
  // answers 0 before the first data arrives never starts it at all. A number that changes only when the
  // project goes live (or stops) does exactly what is wanted.
  const [every, setEvery] = useState({ project: 0, clips: 0 });
  const { data: project, error: projectError, mutate: mutateProject } = useSWR<Project>(id ? `/api/projects/${id}` : null, fetcher, {
    refreshInterval: every.project,
    dedupingInterval: 1000, // SWR's default (2 s) would swallow every other 1.5 s poll
    onErrorRetry: retrySoon,
  });
  const { data: clips, error: clipsError, mutate: mutateClips } = useSWR<Clip[]>(id ? `/api/projects/${id}/clips` : null, fetcher, {
    refreshInterval: every.clips,
    onErrorRetry: retrySoon,
  });
  const live = isLive(project);
  // Clip rows only exist once rendering starts, and the list (with every transcript) is the heavy request:
  // it is fetched when the small project poll says something changed, plus a slow safety poll.
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

  // a clip is being made again (Try again on a card, Save & re-render) but the project still reads as finished
  useEffect(() => {
    if (busy && !live) void mutateProject();
  }, [busy, live, mutateProject]);

  const since = useRunStart(project);
  const [filter, setFilter] = useState<Filter>("all");
  const [restyle, setRestyle] = useState<GenerationSettings | null>(null);
  const [starting, setStarting] = useState(false);

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: 0, pending: 0, approved: 0, rejected: 0 };
    for (const c of clips ?? []) {
      n.all++;
      n[c.review_status]++;
    }
    return n;
  }, [clips]);
  const shown = useMemo(() => (clips ?? []).filter((c) => filter === "all" || c.review_status === filter), [clips, filter]);
  const studio = useClipStudio(clips, shown);
  const updateClip = useCallback((c: Clip) => {
    // a clip sent back to be made again: that is a new, short run, so its clock starts now
    if (isBusy(c) && !readRun(c.project_id)) writeRun(c.project_id, { start: Date.now(), p: 0 });
    void mutateClips((list) => list?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });
  }, [mutateClips]);

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
  ].filter(Boolean).join(" · ");

  async function start(settings?: GenerationSettings) {
    setStarting(true);
    try {
      const p = await api.regenerate(project!.id, settings);
      writeRun(p.id, { start: Date.now(), p: 0 });
      await mutateProject(p, { revalidate: false }); // show the progress card now, not after the next poll
      setRestyle(null);
      setFilter("all");
      toast.success("Making your clips again", { description: "The transcript is reused, so this is faster than the first time." });
    } catch (e) {
      toast.error("Could not start", { description: (e as Error).message });
    } finally {
      setStarting(false);
    }
  }

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
            <Button variant="outline" className="pointer-coarse:h-11 max-sm:flex-1" disabled={live} onClick={() => setRestyle(project.settings)}><Palette /> Re-style</Button>
            {readyCount > 0 ? (
              <Button variant="outline" className="pointer-coarse:h-11 max-sm:flex-1" asChild>
                <a
                  download
                  href={api.exportZipUrl(project.id, approvedCount ? "approved" : "all")}
                  onClick={() => toast("Packing your clips into one ZIP file", { description: "The download starts by itself in a moment." })}
                >
                  <Download /> {approvedCount ? `Download ${approvedCount} approved` : "Download all"}
                </a>
              </Button>
            ) : (
              // a link cannot be disabled, so with nothing to download this is a real (disabled) button
              <Button variant="outline" className="pointer-coarse:h-11 max-sm:flex-1" disabled title="There are no finished clips yet"><Download /> Download all</Button>
            )}
          </>
        }
      />

      {live && <LiveCard project={project} since={since} offline={!!projectError} />}
      {project.status === "failed" && <FailedCard project={project} retrying={starting} onRetry={() => start()} />}

      {counts.all > 0 && (
        <div role="group" aria-label="Show" className="mb-4 flex gap-1 sm:mb-5 sm:gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "relative min-w-0 rounded-full px-1.5 py-1.5 text-[0.8125rem] whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[.97] max-sm:flex-auto sm:px-4 sm:text-sm pointer-coarse:min-h-10 pointer-coarse:min-w-10",
                filter === f.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filter === f.key && <motion.span layoutId="clip-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" transition={{ duration: 0.2 }} />}
              <span className="relative">{f.label} <span className="text-muted-foreground tabular-nums">{counts[f.key]}</span></span>
            </button>
          ))}
        </div>
      )}

      {shown.length > 0 ? (
        <div className={CLIP_GRID}>
          {shown.map((c, i) => <ClipCard key={c.id} clip={c} index={i} onChange={updateClip} onOpen={studio.open} />)}
        </div>
      ) : counts.all > 0 ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:p-12">
          No clips in this group.
          <div className="mt-3"><Button variant="outline" size="sm" className="pointer-coarse:h-10" onClick={() => setFilter("all")}>Show all {counts.all}</Button></div>
        </div>
      ) : live ? (
        <WaitingWall count={Math.max(4, Math.min(Number(project.settings.clip_count) || 10, 12))} />
      ) : !clips ? (
        clipsError ? (
          <Notice title="Could not load the clips" text="Check your connection and try again.">
            <Button variant="outline" onClick={() => mutateClips()}><RotateCcw /> Try again</Button>
          </Notice>
        ) : (
          <ClipGridSkeleton count={10} />
        )
      ) : project.status !== "failed" ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:p-12">
          <Sparkles className="mx-auto mb-2 size-6 text-primary" />
          No clips here yet.
        </div>
      ) : null}

      <ClipStudio clips={studio.clips} index={studio.index} onOpen={studio.open} onClose={studio.close} onChange={updateClip} />

      <Dialog open={!!restyle} onOpenChange={(o) => !o && !starting && setRestyle(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Re-style this project</DialogTitle>
            <DialogDescription>Pick a new look, then make the clips again. The clips you have now are replaced.</DialogDescription>
          </DialogHeader>
          <DialogBody>{restyle && <StyleSelector value={restyle} onChange={setRestyle} />}</DialogBody>
          <DialogFooter>
            <Button variant="ghost" className="pointer-coarse:h-11" disabled={starting} onClick={() => setRestyle(null)}>Cancel</Button>
            <Button className="bg-brand text-white pointer-coarse:h-11" disabled={starting || !restyle} onClick={() => restyle && start(restyle)}>
              {starting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {starting ? "Starting…" : `Re-generate ${restyle?.clip_count ?? ""} clips`}
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
