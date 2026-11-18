"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Flame, Loader2, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import { api, type Clip, type Platform } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? "#f97316" : score >= 50 ? "#d946ef" : "#8b5cf6";
  return (
    <span className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.15)" strokeWidth={3} fill="rgba(0,0,0,.55)" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} />
      </svg>
      <span className="absolute text-[11px] font-semibold text-white tabular-nums">{Math.round(score)}</span>
    </span>
  );
}

/** Thumbnail that plays (muted) on hover; click opens the clip studio. */
export function ClipCard({ clip, index = 0, onOpen, onChange }: { clip: Clip; index?: number; onOpen: () => void; onChange?: (c: Clip) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const ready = clip.status === "ready";
  const posted = Object.keys(clip.posted ?? {}) as Platform[];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.4) }}
      className={cn("group relative", clip.review_status === "rejected" && "opacity-45")}
    >
      <button
        type="button"
        disabled={!ready}
        onClick={onOpen}
        onMouseEnter={() => { setHover(true); video.current?.play().catch(() => {}); }}
        onMouseLeave={() => { setHover(false); if (video.current) { video.current.pause(); video.current.currentTime = 0; } }}
        className="relative block aspect-[9/16] w-full overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-left shadow-lg transition duration-300 hover:-translate-y-1 hover:border-white/25 hover:shadow-2xl hover:shadow-fuchsia-500/10"
      >
        {ready && clip.video_url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {clip.thumb_url && <img src={clip.thumb_url} alt="" className={cn("absolute inset-0 h-full w-full object-cover transition-opacity", hover && "opacity-0")} />}
            <video ref={video} src={hover ? clip.video_url : undefined} muted playsInline loop preload="none" className="absolute inset-0 h-full w-full object-cover" />
          </>
        ) : (
          <div className="skeleton absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted-foreground">
            {clip.status === "failed" ? (
              <span className="flex flex-col items-center gap-2 text-destructive"><TriangleAlert className="size-6" />Render failed</span>
            ) : (
              <span className="flex flex-col items-center gap-2"><Loader2 className="size-6 animate-spin text-primary" />{clip.status === "rendering" ? "Rendering…" : "In queue"}</span>
            )}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/0 to-black/30" />
        <div className="absolute top-2.5 left-2.5"><ScoreRing score={clip.score} /></div>
        <div className="absolute top-3 right-3 flex gap-1">
          {clip.review_status === "approved" && <span className="grid size-6 place-items-center rounded-full bg-emerald-500 text-white shadow"><Check className="size-3.5" /></span>}
        </div>
        {ready && (
          <span className="absolute top-1/2 left-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-white/20 opacity-0 backdrop-blur transition group-hover:scale-100 group-hover:opacity-100">
            <Play className="size-5 fill-white text-white" />
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 p-3">
          <div className="line-clamp-2 text-[13px] leading-snug font-semibold text-white drop-shadow">{clip.title}</div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/70">
            <span className="flex items-center gap-1"><Flame className="size-3 text-orange-400" />#{clip.rank} · {Math.round(clip.duration)}s</span>
            <span className="flex -space-x-1">{posted.map((p) => <PlatformIcon key={p} platform={p} className="size-4 text-[6px] ring-2 ring-black" />)}</span>
          </div>
        </div>
      </button>
      {clip.status === "failed" && (
        <button onClick={async () => onChange?.(await api.rerenderClip(clip.id))} className="absolute right-2 bottom-2 flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs backdrop-blur hover:bg-white/20">
          <RefreshCw className="size-3" /> Retry
        </button>
      )}
      <div className="sr-only">{fmtDuration(clip.start)}</div>
    </motion.div>
  );
}
