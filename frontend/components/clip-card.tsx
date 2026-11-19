"use client";

import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Flame, Hourglass, Loader2, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import { api, type Clip, type Platform } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The one grid used for every wall of clips (project page, library, loading states).
 * Columns come from the space there is, not from breakpoints: 2 on a small phone,
 * 4 on a tablet, 5-6 on a laptop, 7-8 on a big monitor. Landscape phones get
 * smaller cards so a whole card fits on the screen.
 */
export const CLIP_GRID = cn(
  "grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,calc(50%_-_0.375rem)),1fr))] gap-3 sm:gap-4",
  // 112rem, not 1800px: Tailwind can only put it after `xl:` when both are in rem
  "xl:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] min-[112rem]:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]",
  "short:grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))] short:gap-3",
);

/** Placeholder cards with the exact shape of the real grid, so nothing jumps when clips arrive. */
export function ClipGridSkeleton({ count = 10, className }: { count?: number; className?: string }) {
  return (
    <div aria-hidden className={cn(CLIP_GRID, className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton aspect-[9/16] rounded-2xl" />
      ))}
    </div>
  );
}

export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? "#f97316" : score >= 50 ? "#d946ef" : "#8b5cf6";
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} title={`Score ${Math.round(score)} out of 100`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.15)" strokeWidth={3} fill="rgba(0,0,0,.55)" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, score)) / 100)} />
      </svg>
      <span className="absolute text-[0.6875rem] font-semibold text-white tabular-nums">{Math.round(score)}</span>
    </span>
  );
}

/** A mouse can preview on hover. A finger cannot hover, and a metered connection should not pay for it. */
function wantsHoverPreview(e: React.PointerEvent) {
  if (e.pointerType !== "mouse") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

/**
 * Thumbnail card. Click or tap opens the clip studio; resting a mouse on it plays a muted preview.
 * Memoised, with no layout animation: a progress poll must not re-measure every card on the page.
 * Pass stable `onOpen` / `onChange` callbacks.
 */
export const ClipCard = memo(function ClipCard({ clip, index = 0, onOpen, onChange }: {
  clip: Clip;
  index?: number;
  onOpen: (id: number) => void;
  onChange?: (c: Clip) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef(0);
  const [preview, setPreview] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const ready = clip.status === "ready" && !!clip.video_url;
  const failed = clip.status === "failed";
  const posted = Object.keys(clip.posted ?? {}) as Platform[];

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function startPreview(e: React.PointerEvent) {
    if (!ready || !wantsHoverPreview(e)) return;
    window.clearTimeout(timer.current);
    // a short wait, so sweeping the mouse across the grid does not start a download per card
    timer.current = window.setTimeout(() => setPreview(true), 220);
  }
  function stopPreview() {
    window.clearTimeout(timer.current);
    const v = video.current;
    if (v) {
      // removing src and calling load() is what really cancels the download
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    setPreview(false);
  }

  async function retry() {
    setRetrying(true);
    try {
      onChange?.(await api.rerenderClip(clip.id));
    } catch (e) {
      toast.error("Could not try this clip again", { description: (e as Error).message });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className={cn(
        "group relative min-w-0 animate-in duration-300 fill-mode-both fade-in-0 motion-reduce:animate-none",
        clip.review_status === "rejected" && "opacity-45",
      )}
      style={{ animationDelay: `${Math.min(index * 15, 120)}ms` }}
    >
      <button
        type="button"
        disabled={!ready}
        onClick={() => { stopPreview(); onOpen(clip.id); }}
        onPointerEnter={startPreview}
        onPointerLeave={stopPreview}
        className="relative block aspect-[9/16] w-full overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-left shadow-lg transition duration-300 outline-none hover:-translate-y-1 hover:border-white/25 hover:shadow-2xl hover:shadow-fuchsia-500/10 focus-visible:border-white/40 focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-[.98] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        {ready ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {clip.thumb_url && <img src={clip.thumb_url} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
            {/* only mounted while the mouse rests here; the thumbnail stays underneath, so there is no black flash */}
            {preview && <video ref={video} src={clip.video_url ?? undefined} autoPlay muted playsInline loop className="absolute inset-0 h-full w-full object-cover" />}
          </>
        ) : (
          // only the clip being made right now moves; a wall of waiting cards stays still (it can be on screen for a long time)
          <div className={cn("absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted-foreground", failed ? "bg-destructive/10" : clip.status === "rendering" ? "skeleton" : "bg-white/[.03]")}>
            {failed ? (
              <span className="flex -translate-y-5 flex-col items-center gap-2 text-destructive"><TriangleAlert className="size-6" />This clip did not render</span>
            ) : clip.status === "rendering" ? (
              <span className="flex flex-col items-center gap-2 text-foreground"><Loader2 className="size-6 animate-spin text-primary" />Making this clip…</span>
            ) : (
              <span className="flex flex-col items-center gap-2"><Hourglass className="size-5 opacity-60" />Waiting its turn</span>
            )}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/0 to-black/30" />
        <div className="absolute top-2.5 left-2.5"><ScoreRing score={clip.score} /></div>
        <div className="absolute top-3 right-3 flex items-center gap-1.5">
          {/* a touch screen cannot hover: a small, quiet play mark that is always there */}
          {ready && <span aria-hidden className="hidden size-6 place-items-center rounded-full bg-black/55 [@media(hover:none)]:grid"><Play className="size-3 fill-white text-white" /></span>}
          {clip.review_status === "approved" && <span className="grid size-6 place-items-center rounded-full bg-emerald-500 text-white shadow" title="Approved"><Check className="size-3.5" /></span>}
        </div>
        {ready && (
          // with a mouse: the big play button fades in on hover
          <span aria-hidden className="absolute top-1/2 left-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-white/20 opacity-0 backdrop-blur transition group-hover:scale-100 group-hover:opacity-100 [@media(hover:none)]:hidden">
            <Play className="size-5 fill-white text-white" />
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 min-w-0 p-3">
          <div className="line-clamp-2 text-[0.8125rem] leading-snug font-semibold wrap-anywhere text-white drop-shadow">{clip.title}</div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[0.6875rem] text-white/70">
            <span className="flex min-w-0 items-center gap-1 whitespace-nowrap"><Flame className="size-3 shrink-0 text-orange-400" />#{clip.rank} · {Math.round(clip.duration)}s</span>
            <span className="flex shrink-0 -space-x-1">{posted.map((p) => <PlatformIcon key={p} platform={p} className="size-4 text-[0.375rem] ring-2 ring-black" />)}</span>
          </div>
        </div>
      </button>
      {failed && (
        // outside the (disabled) card button: a button inside a button is not valid
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex justify-center pt-4">
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            title={clip.error ?? undefined}
            className="pointer-events-auto flex min-h-9 items-center gap-1.5 rounded-lg bg-white/15 px-3 text-xs font-medium text-white backdrop-blur transition hover:bg-white/25 active:scale-[.97] disabled:opacity-60 pointer-coarse:min-h-10 pointer-coarse:text-sm"
          >
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Try again
          </button>
        </div>
      )}
    </div>
  );
});
