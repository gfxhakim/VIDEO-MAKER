"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { mutate as globalMutate, preload } from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Camera, Check, ChevronLeft, ChevronRight, Copy, Download, FileText, Loader2, RefreshCw, Save, Scissors, Share2, Sliders, Sparkles, ThumbsDown, ThumbsUp, Trash2, X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { aspectClass, ScoreRing } from "@/components/clip-card";
import { PLATFORMS, PLATFORM_LABEL, PLATFORM_SHORT, PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  fetcher,
  type Clip,
  type GenerationSettings,
  type MusicTrack,
  type Platform,
  type Presets,
  type PublishKit,
  type WordToken,
} from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

const NO_CLIPS: Clip[] = [];

export function useClipStudio(all: Clip[] | undefined, visible: Clip[]) {
  const [session, setSession] = useState<{ id: number; keep: ReadonlySet<number> } | null>(null);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const clips = useMemo(() => {
    if (!session || !all) return NO_CLIPS;
    const shown = new Set(visible.map((c) => c.id));
    return all.filter((c) => c.status === "ready" && (session.keep.has(c.id) || shown.has(c.id)));
  }, [session, all, visible]);
  const index = session ? clips.findIndex((c) => c.id === session.id) : -1;

  const gone = !!session && !!all && index < 0;
  useEffect(() => {
    if (gone) setSession(null);
  }, [gone]);

  const open = useCallback((id: number) => {
    setSession((s) => ({ id, keep: s?.keep ?? new Set(visibleRef.current.map((c) => c.id)) }));
  }, []);
  const close = useCallback(() => setSession(null), []);

  return { clips, index, open, close };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.03]">
      <div className="flex items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <button
          type="button"
          onClick={async () => {
            if (!(await copyText(text))) return void toast.error("Could not copy", { description: "Press and hold the text to copy it by hand." });
            setDone(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1400);
          }}
          className={cn(
            "flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs transition active:scale-[.97] pointer-coarse:min-h-10 pointer-coarse:px-3 pointer-coarse:text-sm",
            done ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
          )}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="px-3 pt-0.5 pb-3 text-sm wrap-anywhere whitespace-pre-wrap select-text">{text}</p>
    </div>
  );
}

const SIGNALS: [string, string][] = [["hook", "Hook"], ["energy", "Energy"], ["emotion", "Emotion"], ["density", "Pace"], ["spikes", "Reactions"], ["action", "Action"]];

type FormState = {
  title: string;
  hook: string;
  description: string;
  tags: string;
  start: number;
  end: number;
  music_track_id: number | null;
  caption_style: string;
  editing_style: string;
  aspect_ratio: string;
  auto_emoji: string; // "" (inherit) | "true" | "false"
  hook_title: string; // "" | "true" | "false"
};

const formOf = (c: Clip): FormState => ({
  title: c.title,
  hook: c.hook,
  description: c.description,
  tags: c.hashtags.join(" "),
  start: Number(c.start.toFixed(2)),
  end: Number(c.end.toFixed(2)),
  music_track_id: c.music_track_id ?? null,
  caption_style: (c.overrides?.caption_style as string) || "",
  editing_style: (c.overrides?.editing_style as string) || "",
  aspect_ratio: (c.overrides?.aspect_ratio as string) || "",
  auto_emoji: c.overrides?.auto_emoji === undefined ? "" : String(c.overrides.auto_emoji),
  hook_title: c.overrides?.hook_title === undefined ? "" : String(c.overrides.hook_title),
});

function canShareFiles() {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare && navigator.canShare({ files: [new File([""], "clip.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
}

type ShareState = { id: number; pct: number | null; file: File | null };

const FRAME_VARS = cn(
  "[--ph:min(44dvh,26rem)] sm:[--ph:min(48dvh,34rem)]",
  "lg:[--ph:min(76dvh,47.5rem,calc(100dvh_-_8rem),calc(81.8vw_-_15.7rem))] 2xl:[--ph:min(76dvh,52rem,calc(100dvh_-_8rem))]",
  "short:[--ph:calc(100dvh_-_1.25rem)]",
);

const NAV_ARROW = "absolute top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 transition outline-none hover:bg-white/20 focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-95 disabled:pointer-events-none disabled:opacity-20 lg:grid short:hidden";
const SELECT = "mt-1.5 h-10 w-full rounded-lg border border-white/15 bg-zinc-900 px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ClipStudio({
  clips,
  index,
  projectAspect,
  onOpen,
  onClose,
  onChange,
  onDelete,
}: {
  clips: Clip[];
  index: number | null;
  projectAspect?: string;
  onOpen: (id: number) => void;
  onClose: () => void;
  onChange: (c: Clip) => void;
  onDelete?: (id: number) => void;
}) {
  const clip = index != null && index >= 0 ? clips[index] ?? null : null;
  const at = clip ? (index as number) : -1;
  const { data: kit, error: kitError, mutate: mutateKit } = useSWR<PublishKit>(clip ? `/api/clips/${clip.id}/kit` : null, fetcher, { revalidateOnFocus: false });
  const { data: presets } = useSWR<Presets>("/api/presets", fetcher, { revalidateOnFocus: false });
  const { data: music } = useSWR<MusicTrack[]>("/api/music", fetcher);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [tab, setTab] = useState<"publish" | "edit">("publish");
  const [form, setForm] = useState<FormState>(() => (clip ? formOf(clip) : { title: "", hook: "", description: "", tags: "", start: 0, end: 10, music_track_id: null, caption_style: "", editing_style: "", aspect_ratio: "", auto_emoji: "", hook_title: "" }));
  const [words, setWords] = useState<WordToken[] | null>(null);
  const [wordsDirty, setWordsDirty] = useState(false);
  const [loadingWords, setLoadingWords] = useState(false);
  const [saving, setSaving] = useState<"save" | "render" | "thumb" | "ai" | "delete" | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareable] = useState(canShareFiles);
  const shareAbort = useRef<AbortController | null>(null);
  const seq = useRef(new Map<string, number>());
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const clipId = clip?.id;
  useEffect(() => {
    if (clip) {
      setForm(formOf(clip));
      setWords(null);
      setWordsDirty(false);
    }
    for (const el of [scroller.current, panel.current, body.current]) el?.scrollTo({ top: 0 });
    return () => shareAbort.current?.abort();
  }, [clipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadWords = useCallback(async () => {
    if (!clipId || words !== null) return;
    setLoadingWords(true);
    try {
      const res = await api.getClipWords(clipId);
      setWords(res.words);
    } catch {
      setWords([]);
    } finally {
      setLoadingWords(false);
    }
  }, [clipId, words]);

  const prev = at > 0 ? clips[at - 1] : null;
  const next = at >= 0 && at < clips.length - 1 ? clips[at + 1] : null;
  const prevId = prev?.id;
  const nextId = next?.id;
  const nextThumb = next?.thumb_url;

  useEffect(() => {
    if (nextId == null) return;
    if (nextThumb) new Image().src = nextThumb;
    preload(`/api/clips/${nextId}/kit`, fetcher).catch(() => {});
  }, [nextId, nextThumb]);

  const go = useCallback((d: number) => {
    const id = d < 0 ? prevId : nextId;
    if (id != null) onOpen(id);
  }, [prevId, nextId, onOpen]);

  const optimistic = useCallback(async (key: string, target: Clip, patched: Clip, send: () => Promise<Clip>) => {
    const mine = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, mine);
    onChange(patched);
    try {
      const saved = await send();
      if (seq.current.get(key) === mine) onChange(saved);
      return true;
    } catch (e) {
      if (seq.current.get(key) === mine) onChange(target);
      toast.error("That did not save", { description: (e as Error).message });
      return false;
    }
  }, [onChange]);

  const review = useCallback((to: Clip["review_status"]) => {
    if (!clip) return;
    const status = clip.review_status === to ? "pending" : to;
    void optimistic(`review:${clip.id}`, clip, { ...clip, review_status: status }, () => api.updateClip(clip.id, { review_status: status }));
  }, [clip, optimistic]);

  const isOpen = !!clip;
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        review("approved");
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        review("rejected");
      } else if (e.key === " ") {
        const v = videoEl.current;
        if (v) {
          e.preventDefault();
          if (v.paused) void v.play();
          else v.pause();
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isOpen, go, review]);

  if (!clip) return null;
  const k = kit?.[platform];
  const isPosted = !!clip.posted?.[platform];
  const shareNow = share && share.id === clip.id ? share : null;
  const initial = formOf(clip);
  const dirty =
    wordsDirty ||
    form.title !== initial.title ||
    form.hook !== initial.hook ||
    form.description !== initial.description ||
    form.tags !== initial.tags ||
    Math.abs(form.start - initial.start) > 0.01 ||
    Math.abs(form.end - initial.end) > 0.01 ||
    form.music_track_id !== initial.music_track_id ||
    form.caption_style !== initial.caption_style ||
    form.editing_style !== initial.editing_style ||
    form.aspect_ratio !== initial.aspect_ratio ||
    form.auto_emoji !== initial.auto_emoji ||
    form.hook_title !== initial.hook_title;

  const activeAspect = (clip.overrides?.aspect_ratio as string | undefined) || projectAspect || "9:16";
  const isWide = activeAspect === "16:9";

  async function togglePosted() {
    const target = clip!;
    const posted = { ...target.posted };
    if (isPosted) delete posted[platform];
    else posted[platform] = new Date().toISOString();
    const review_status = !isPosted && target.review_status === "pending" ? "approved" : target.review_status;
    const ok = await optimistic(`posted:${target.id}:${platform}`, target, { ...target, posted, review_status }, () => api.markPosted(target.id, platform, !isPosted));
    if (ok && !isPosted) toast.success(`Marked as posted on ${PLATFORM_LABEL[platform]}`);
  }

  async function save(rerender: boolean) {
    const target = clip!;
    setSaving(rerender ? "render" : "save");
    try {
      const overrides: Partial<GenerationSettings> = { ...(target.overrides || {}) };
      if (form.caption_style) overrides.caption_style = form.caption_style;
      else delete overrides.caption_style;
      if (form.editing_style) overrides.editing_style = form.editing_style;
      else delete overrides.editing_style;
      if (form.aspect_ratio) overrides.aspect_ratio = form.aspect_ratio;
      else delete overrides.aspect_ratio;
      if (form.auto_emoji) overrides.auto_emoji = form.auto_emoji === "true";
      else delete overrides.auto_emoji;
      if (form.hook_title) overrides.hook_title = form.hook_title === "true";
      else delete overrides.hook_title;

      const saved = await api.updateClip(target.id, {
        title: form.title,
        hook: form.hook,
        description: form.description,
        hashtags: form.tags.split(/[\s,]+/).filter(Boolean),
        start: form.start,
        end: form.end,
        music_track_id: form.music_track_id ?? undefined,
        clear_music: form.music_track_id === null,
        overrides,
        ...(wordsDirty && words ? { words_override: words } : {}),
      });
      onChange(saved);
      setForm(formOf(saved));
      setWordsDirty(false);
      void mutateKit();
      if (!rerender) return void toast.success("Saved");
      onChange(await api.rerenderClip(target.id));
      toast.success("Making this clip again with your changes");
      onClose();
    } catch (e) {
      toast.error("Could not save", { description: (e as Error).message });
    } finally {
      setSaving(null);
    }
  }

  async function captureCover() {
    const target = clip!;
    const atSec = videoEl.current?.currentTime ?? Math.min(1.5, target.duration / 2);
    setSaving("thumb");
    try {
      const updated = await api.captureThumbnail(target.id, atSec);
      onChange(updated);
      toast.success(`Cover updated from ${fmtDuration(atSec)}`);
    } catch (e) {
      toast.error("Could not capture cover", { description: (e as Error).message });
    } finally {
      setSaving(null);
    }
  }

  async function aiRewrite() {
    const target = clip!;
    setSaving("ai");
    try {
      const updated = await api.aiRewriteClip(target.id);
      onChange(updated);
      setForm(formOf(updated));
      void mutateKit();
      toast.success("Hook, title & hashtags updated with AI");
    } catch (e) {
      toast.error("Could not rewrite with AI", { description: (e as Error).message });
    } finally {
      setSaving(null);
    }
  }

  async function removeClip() {
    const target = clip!;
    if (!window.confirm(`Delete "${target.title}" permanently?`)) return;
    setSaving("delete");
    try {
      await api.deleteClip(target.id);
      onDelete?.(target.id);
      void globalMutate(`/api/projects/${target.project_id}/clips`);
      onClose();
      toast.success("Clip deleted");
    } catch (e) {
      toast.error("Could not delete clip", { description: (e as Error).message });
    } finally {
      setSaving(null);
    }
  }

  async function fetchForShare(target: Clip) {
    shareAbort.current?.abort();
    const ac = new AbortController();
    shareAbort.current = ac;
    setShare({ id: target.id, pct: null, file: null });
    try {
      const res = await fetch(target.video_url!, { credentials: "include", signal: ac.signal });
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let blob: Blob;
      if (res.body) {
        const reader = res.body.getReader();
        const parts: Uint8Array[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : null;
          setShare((s) => (s && s.id === target.id && s.pct === pct ? s : { id: target.id, pct, file: null }));
        }
        blob = new Blob(parts as BlobPart[], { type: "video/mp4" });
      } else {
        blob = await res.blob();
      }
      const name = `${target.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 40) || "clip"}.mp4`;
      const file = new File([blob], name, { type: "video/mp4" });
      setShare({ id: target.id, pct: null, file });
      return file;
    } catch (e) {
      setShare((s) => (s?.id === target.id ? null : s));
      if (!ac.signal.aborted) toast.error("Could not get the video ready", { description: (e as Error).message });
      return null;
    }
  }

  async function openShareSheet(file: File, fromTap: boolean) {
    const text = k?.caption ?? clip!.title;
    void copyText(text);
    try {
      await navigator.share({ files: [file], text });
      toast.success("Caption copied too. Paste it in the app.");
    } catch (e) {
      const name = (e as Error).name;
      if (name === "AbortError") return;
      if (name === "NotAllowedError" && !fromTap) return;
      toast.error("Could not open sharing", { description: "Use Download instead, then post from your gallery." });
    }
  }

  async function onShare() {
    if (shareNow?.file) return void openShareSheet(shareNow.file, true);
    const file = await fetchForShare(clip!);
    if (file && navigator.userActivation?.isActive) void openShareSheet(file, false);
  }

  const nudge = (which: "start" | "end", delta: number) => {
    setForm((f) => {
      if (which === "start") {
        const s = Math.max(0, Math.min(f.end - 1.5, Number((f.start + delta).toFixed(2))));
        return { ...f, start: s };
      }
      const e = Math.max(f.start + 1.5, Number((f.end + delta).toFixed(2)));
      return { ...f, end: e };
    });
  };

  const counter = `${at + 1} / ${clips.length}`;
  const meta = `Clip ${at + 1} of ${clips.length} · ${fmtDuration(clip.start)}–${fmtDuration(clip.end)} · ${Math.round(clip.duration)}s`;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-stretch justify-center outline-none sm:inset-4 lg:inset-8 lg:items-center short:inset-0 short:items-stretch"
          onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div className={cn(
            FRAME_VARS,
            "relative flex w-full max-w-6xl flex-col overflow-hidden bg-card shadow-2xl animate-in duration-200 fade-in-0 zoom-in-95 motion-reduce:animate-none sm:rounded-3xl sm:border sm:border-white/10 2xl:max-w-7xl",
            "lg:h-[min(100%,calc(var(--ph)_+_4rem))]",
            "short:h-full short:max-w-none short:rounded-none short:border-0",
          )}>
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute top-[calc(env(safe-area-inset-top)+0.375rem)] right-[max(0.375rem,env(safe-area-inset-right))] z-30 grid size-10 place-items-center rounded-full bg-white/10 transition outline-none hover:bg-white/20 focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-95 lg:top-3 lg:right-3 short:top-2 short:right-[max(0.5rem,env(safe-area-inset-right))]"
            >
              <X className="size-5" />
            </DialogPrimitive.Close>

            <div className="box-content flex h-13 shrink-0 items-center border-b border-white/10 pt-[env(safe-area-inset-top)] pr-14 pl-4 text-sm text-muted-foreground lg:hidden short:hidden">
              <span className="min-w-0 truncate">{meta}</span>
            </div>

            <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:flex-row lg:overflow-hidden short:flex-row short:overflow-hidden">
              {/* player */}
              <div
                className="relative flex shrink-0 touch-pan-y flex-col items-center justify-center bg-black/40 px-4 py-3 sm:p-4 lg:w-[46%] lg:p-8 short:w-auto short:p-2.5 short:pl-[max(0.625rem,env(safe-area-inset-left))]"
                onTouchStart={(e) => {
                  const t = e.touches[0];
                  const box = frame.current?.getBoundingClientRect();
                  const onControls = !!box && t.clientY > box.bottom - 76 && t.clientY < box.bottom && t.clientX > box.left && t.clientX < box.right;
                  swipe.current = e.touches.length === 1 && !onControls ? { x: t.clientX, y: t.clientY } : null;
                }}
                onTouchEnd={(e) => {
                  const from = swipe.current;
                  swipe.current = null;
                  const t = e.changedTouches[0];
                  if (!from || !t) return;
                  const dx = t.clientX - from.x;
                  const dy = t.clientY - from.y;
                  if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.8) go(dx < 0 ? 1 : -1);
                }}
              >
                <button type="button" onClick={() => go(-1)} disabled={!prev} aria-label="Previous clip" title="Previous clip (left arrow key)" className={cn(NAV_ARROW, "left-2")}><ChevronLeft /></button>
                <motion.div
                  key={clip.id}
                  ref={frame}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.18 }}
                  className={cn(
                    "relative overflow-hidden rounded-[1.625rem] bg-black shadow-2xl ring-4 ring-zinc-800 short:rounded-2xl short:ring-2",
                    aspectClass(activeAspect),
                    isWide ? "w-full max-w-md" : "h-(--ph)",
                  )}
                >
                  <video ref={videoEl} src={clip.video_url ?? undefined} poster={clip.thumb_url ?? undefined} controls autoPlay playsInline preload="auto" className="h-full w-full object-contain" />
                </motion.div>
                <p className="mt-2 hidden text-[11px] text-muted-foreground lg:block short:hidden">
                  Keys: <kbd className="rounded bg-white/10 px-1">Space</kbd> play · <kbd className="rounded bg-white/10 px-1">A</kbd> approve · <kbd className="rounded bg-white/10 px-1">R</kbd> reject · <kbd className="rounded bg-white/10 px-1">←/→</kbd> step
                </p>
                <button type="button" onClick={() => go(1)} disabled={!next} aria-label="Next clip" title="Next clip (right arrow key)" className={cn(NAV_ARROW, "right-2")}><ChevronRight /></button>
              </div>

              {/* side */}
              <div className="flex min-w-0 flex-1 flex-col lg:min-h-0 short:min-h-0">
                <div ref={panel} className="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-hidden short:min-h-0 short:overflow-y-auto short:overscroll-contain">
                  <div className="shrink-0 border-b border-white/10 p-4 sm:p-5 short:pr-[calc(max(0.5rem,env(safe-area-inset-right))_+_3rem)]">
                    <div className="flex items-center gap-3 lg:items-start lg:pr-12 short:items-start short:pr-0">
                      <ScoreRing score={clip.score} size={46} />
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 hidden text-xs text-muted-foreground lg:block short:block">{meta}</div>
                        <DialogPrimitive.Title className="line-clamp-3 text-base leading-snug font-semibold wrap-anywhere sm:text-lg">{clip.title}</DialogPrimitive.Title>
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
                      {SIGNALS.map(([key, label]) => {
                        const v = Math.max(0, Math.min(1, Number(clip.score_breakdown[key] ?? 0) || 0));
                        return (
                          <div key={key} className="min-w-0 text-[0.6875rem] text-muted-foreground">
                            <div className="mb-1 truncate">{label}</div>
                            <div className="h-1 overflow-hidden rounded-full bg-white/10"><div className="bg-brand h-full rounded-full transition-[width] duration-300" style={{ width: `${v * 100}%` }} /></div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant={clip.review_status === "approved" ? "default" : "outline"}
                        aria-pressed={clip.review_status === "approved"}
                        className="pointer-coarse:h-10 pointer-coarse:px-3.5"
                        onClick={() => review("approved")}
                      >
                        <ThumbsUp /> {clip.review_status === "approved" ? "Approved" : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-pressed={clip.review_status === "rejected"}
                        aria-label={clip.review_status === "rejected" ? "Rejected" : "Reject"}
                        className={cn("pointer-coarse:h-10 pointer-coarse:px-3.5", clip.review_status === "rejected" && "border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive")}
                        onClick={() => review("rejected")}
                      >
                        <ThumbsDown /> <span className="max-[379px]:sr-only">{clip.review_status === "rejected" ? "Rejected" : "Reject"}</span>
                      </Button>
                      <div role="tablist" aria-label="What to do with this clip" className="ml-auto flex shrink-0 rounded-lg bg-white/5 p-0.5 text-sm">
                        {(["publish", "edit"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={tab === t}
                            onClick={() => setTab(t)}
                            className={cn("relative rounded-md px-3 py-1 capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-10 pointer-coarse:px-3.5", tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                          >
                            {tab === t && <motion.span layoutId="studio-tab" className="absolute inset-0 rounded-md bg-white/10" transition={{ duration: 0.18 }} />}
                            <span className="relative">{t}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div ref={body} role="tabpanel" aria-label={tab === "publish" ? "Publish" : "Edit"} className="p-4 sm:p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain short:flex-none short:overflow-visible short:pr-[calc(max(0.5rem,env(safe-area-inset-right))_+_3rem)]">
                    {tab === "publish" ? (
                      <div className="flex flex-col gap-4">
                        <div role="radiogroup" aria-label="Where you will post" className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
                          {PLATFORMS.map((p) => (
                            <button
                              key={p}
                              type="button"
                              role="radio"
                              aria-checked={platform === p}
                              title={PLATFORM_LABEL[p]}
                              onClick={() => setPlatform(p)}
                              className={cn(
                                "relative flex min-w-0 flex-col items-center gap-1 rounded-xl border px-1 py-2 text-xs transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-[.97] sm:flex-row sm:gap-2 sm:px-3 sm:text-sm pointer-coarse:min-h-11",
                                platform === p ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/5",
                              )}
                            >
                              <PlatformIcon platform={p} className="size-5 text-[0.5rem]" />
                              <span className="max-w-full truncate">{PLATFORM_SHORT[p]}</span>
                              {clip.posted?.[p] && (
                                <span className="grid size-4 place-items-center rounded-full bg-emerald-500 text-white max-sm:absolute max-sm:top-1 max-sm:right-1 sm:size-auto sm:bg-transparent sm:text-emerald-400" title="Posted">
                                  <Check className="size-3 sm:size-3.5" />
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                        {k ? (
                          <>
                            {platform === "youtube" && <CopyBlock label="Title" text={k.title} />}
                            <CopyBlock label={platform === "youtube" ? "Description" : "Caption"} text={k.caption} />
                            <CopyBlock label="Hashtags" text={k.hashtags.join(" ")} />
                          </>
                        ) : kitError ? (
                          <>
                            <CopyBlock label="Caption" text={clip.description || clip.title} />
                            <CopyBlock label="Hashtags" text={clip.hashtags.join(" ")} />
                            <button type="button" onClick={() => mutateKit()} className="self-start text-xs text-primary underline underline-offset-4 pointer-coarse:min-h-10">
                              Load the captions made for {PLATFORM_LABEL[platform]}
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="skeleton h-28 rounded-xl" />
                            <div className="skeleton h-16 rounded-xl" />
                          </>
                        )}
                        <div className={cn("grid grid-cols-2 gap-2", shareable && "sm:grid-cols-3")}>
                          <Button asChild variant="secondary" className="pointer-coarse:h-11">
                            <a href={api.clipDownloadUrl(clip.id)} download><Download /> Download MP4</a>
                          </Button>
                          {shareable && (
                            <Button
                              variant={shareNow?.file ? "default" : "secondary"}
                              className={cn("pointer-coarse:h-11", shareNow?.file && "bg-brand text-white")}
                              onClick={onShare}
                              disabled={!!shareNow && !shareNow.file}
                            >
                              {shareNow && !shareNow.file ? (
                                <><Loader2 className="animate-spin" /> <span className="tabular-nums">Loading{shareNow.pct != null ? ` ${shareNow.pct}%` : "…"}</span></>
                              ) : (
                                <><Share2 /> {shareNow?.file ? "Share now" : "Share to app"}</>
                              )}
                            </Button>
                          )}
                          <Button onClick={togglePosted} variant={isPosted ? "outline" : "default"} aria-pressed={isPosted} className={cn("pointer-coarse:h-11", shareable && "col-span-2 sm:col-span-1")}>
                            <Check /> {isPosted ? "Posted" : "Mark posted"}
                          </Button>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button asChild variant="outline" size="sm" className="pointer-coarse:h-10">
                            <a href={api.subtitleDownloadUrl(clip.id, "srt")} download><FileText /> .SRT subtitles</a>
                          </Button>
                          <Button asChild variant="outline" size="sm" className="pointer-coarse:h-10">
                            <a href={api.thumbnailDownloadUrl(clip.id)} download><Camera /> Cover (.jpg)</a>
                          </Button>
                          <Button variant="outline" size="sm" disabled={!!saving} onClick={captureCover} className="pointer-coarse:h-10">
                            {saving === "thumb" ? <Loader2 className="animate-spin" /> : <Camera />} Set frame as cover
                          </Button>
                        </div>

                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {shareNow?.file ? (
                            <>The video is ready. Tap <b>Share now</b> and pick {PLATFORM_LABEL[platform]}. The caption is copied for you to paste.</>
                          ) : shareable ? (
                            <>You post by hand in the {PLATFORM_LABEL[platform]} app, which keeps your accounts safe. <b>Share to app</b> sends the video straight to it and copies the caption.</>
                          ) : (
                            <>You post by hand in the {PLATFORM_LABEL[platform]} app, which keeps your accounts safe. Download the video, copy the caption, then mark it as posted here.</>
                          )}
                        </p>
                      </div>
                    ) : (
                      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) void save(false); }}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">Copy & Hook</span>
                          {presets?.llm_configured && (
                            <Button type="button" variant="outline" size="sm" disabled={!!saving} onClick={aiRewrite} className="h-8 text-xs">
                              {saving === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles className="text-primary" />} Rewrite with AI
                            </Button>
                          )}
                        </div>
                        <label className="text-xs text-muted-foreground">Post title / first line
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">On-screen hook title (used by hook-card styles)
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">Description
                          <Textarea className="mt-1.5 text-foreground pointer-coarse:text-base" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">Hashtags
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="#money #mindset" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                        </label>

                        {/* Trim boundaries */}
                        <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                          <div className="mb-2 flex items-center justify-between text-xs font-medium">
                            <span className="flex items-center gap-1.5"><Scissors className="size-3.5 text-primary" /> Trim clip timestamps</span>
                            <span className="text-muted-foreground tabular-nums">{(form.end - form.start).toFixed(1)}s long</span>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div>
                              <div className="mb-1 text-muted-foreground">Start ({fmtDuration(form.start)})</div>
                              <div className="flex items-center gap-1">
                                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => nudge("start", -1)}>-1s</Button>
                                <Input
                                  type="number" step="0.25" min={0} value={form.start}
                                  onChange={(e) => setForm({ ...form, start: Math.max(0, Number(e.target.value)) })}
                                  className="h-7 px-2 text-xs tabular-nums"
                                />
                                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => nudge("start", 1)}>+1s</Button>
                              </div>
                            </div>
                            <div>
                              <div className="mb-1 text-muted-foreground">End ({fmtDuration(form.end)})</div>
                              <div className="flex items-center gap-1">
                                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => nudge("end", -1)}>-1s</Button>
                                <Input
                                  type="number" step="0.25" min={1} value={form.end}
                                  onChange={(e) => setForm({ ...form, end: Math.max(form.start + 1, Number(e.target.value)) })}
                                  className="h-7 px-2 text-xs tabular-nums"
                                />
                                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => nudge("end", 1)}>+1s</Button>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Per-clip style & music overrides */}
                        <details className="rounded-xl border border-white/10 text-xs">
                          <summary className="flex min-h-10 items-center gap-2 px-3 font-medium text-muted-foreground select-none">
                            <Sliders className="size-3.5 text-primary" /> Style, layout & music overrides (this clip only)
                          </summary>
                          <div className="grid gap-3 border-t border-white/10 p-3 sm:grid-cols-2">
                            <label className="text-muted-foreground">Caption style
                              <select value={form.caption_style} onChange={(e) => setForm({ ...form, caption_style: e.target.value })} className={SELECT}>
                                <option value="">Project default</option>
                                {presets?.caption_styles.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                                <option value="none">No captions</option>
                              </select>
                            </label>
                            <label className="text-muted-foreground">Editing layout
                              <select value={form.editing_style} onChange={(e) => setForm({ ...form, editing_style: e.target.value })} className={SELECT}>
                                <option value="">Project default</option>
                                {presets?.editing_styles.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                              </select>
                            </label>
                            <label className="text-muted-foreground">Shape
                              <select value={form.aspect_ratio} onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })} className={SELECT}>
                                <option value="">Project default</option>
                                {presets?.aspect_ratios.map((a) => <option key={a.key} value={a.key}>{a.key}</option>)}
                              </select>
                            </label>
                            <label className="text-muted-foreground">Background music
                              <select
                                value={form.music_track_id == null ? "" : String(form.music_track_id)}
                                onChange={(e) => setForm({ ...form, music_track_id: e.target.value ? Number(e.target.value) : null })}
                                className={SELECT}
                              >
                                <option value="">No music</option>
                                {music?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                              </select>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-muted-foreground">
                              <span>Auto emojis</span>
                              <select value={form.auto_emoji} onChange={(e) => setForm({ ...form, auto_emoji: e.target.value })} className="h-8 rounded-md border border-white/15 bg-zinc-900 px-2 text-xs text-foreground">
                                <option value="">Default</option>
                                <option value="true">On</option>
                                <option value="false">Off</option>
                              </select>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-muted-foreground">
                              <span>Hook card</span>
                              <select value={form.hook_title} onChange={(e) => setForm({ ...form, hook_title: e.target.value })} className="h-8 rounded-md border border-white/15 bg-zinc-900 px-2 text-xs text-foreground">
                                <option value="">Default</option>
                                <option value="true">On</option>
                                <option value="false">Off</option>
                              </select>
                            </label>
                          </div>
                        </details>

                        {/* Word-level caption typo editor */}
                        <details
                          className="rounded-xl border border-white/10 text-sm"
                          onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void loadWords()}
                        >
                          <summary className="flex min-h-10 items-center justify-between px-3 text-xs font-medium text-muted-foreground select-none">
                            <span>Fix caption transcript words {clip.has_words_override ? "(edited)" : ""}</span>
                            <span className="text-[11px] font-normal">Updates burned-in captions</span>
                          </summary>
                          <div className="border-t border-white/10 p-3">
                            {loadingWords ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading words…</div>
                            ) : !words?.length ? (
                              <p className="text-xs text-muted-foreground">{clip.transcript || "No speech timestamps found in this clip."}</p>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {words.map((w, idx) => (
                                  <input
                                    key={idx}
                                    value={w.word}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setWords((prevW) => prevW ? prevW.map((item, j) => (j === idx ? { ...item, word: val } : item)) : prevW);
                                      setWordsDirty(true);
                                    }}
                                    style={{ width: `${Math.max(4, w.word.length + 2)}ch` }}
                                    className="rounded-md border border-white/10 bg-white/[.04] px-1.5 py-1 text-xs text-foreground outline-none focus:border-primary"
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        </details>

                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Button type="submit" className="pointer-coarse:h-11" disabled={!dirty || !!saving}>
                            {saving === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save
                          </Button>
                          <Button type="button" variant="secondary" className="pointer-coarse:h-11" disabled={!!saving} onClick={() => save(true)}>
                            {saving === "render" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Save & re-render
                          </Button>
                          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-11" disabled={!!saving} onClick={removeClip}>
                            {saving === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
                          </Button>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">Save updates copy/metadata. Save & re-render applies trim, transcript fixes, and style overrides to the video.</p>
                      </form>
                    )}
                  </div>
                </div>

                <div className="sticky bottom-0 z-20 flex shrink-0 items-center justify-between gap-2 border-t border-white/10 bg-card px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] lg:hidden short:static short:flex short:pr-[max(0.5rem,env(safe-area-inset-right))]">
                  <Button size="sm" variant="ghost" className="pointer-coarse:h-10 pointer-coarse:px-3.5" disabled={!prev} onClick={() => go(-1)}><ChevronLeft /> Previous</Button>
                  <span className="text-xs text-muted-foreground tabular-nums" aria-label={`Clip ${at + 1} of ${clips.length}`}>{counter}</span>
                  <Button size="sm" variant="ghost" className="pointer-coarse:h-10 pointer-coarse:px-3.5" disabled={!next} onClick={() => go(1)}>Next <ChevronRight /></Button>
                </div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
