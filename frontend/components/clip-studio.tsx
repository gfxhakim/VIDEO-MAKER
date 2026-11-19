"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { preload } from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Check, ChevronLeft, ChevronRight, Copy, Download, Loader2, RefreshCw, Save, Share2, ThumbsDown, ThumbsUp, X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ScoreRing } from "@/components/clip-card";
import { PLATFORMS, PLATFORM_LABEL, PLATFORM_SHORT, PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, fetcher, type Clip, type Platform, type PublishKit } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

const NO_CLIPS: Clip[] = [];

/**
 * Which clip is open in the studio, and the list you step through with Previous / Next.
 *
 * The list is frozen when the studio opens: approving a clip while the page is filtered to
 * "To review" must not make that clip vanish from under you, or jump you to another one.
 * `all` is every clip the page has (source order), `visible` is what the grid shows right now.
 */
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

  // the open clip went away (it is being rendered again, or was replaced by a new run)
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
    return false; // blocked by the browser, or the page is not on https
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

type FormState = { title: string; hook: string; description: string; tags: string };
const formOf = (c: Clip): FormState => ({ title: c.title, hook: c.hook, description: c.description, tags: c.hashtags.join(" ") });

/** Phones (and other browsers) that can hand a video file to another app. Desktop browsers mostly cannot. */
function canShareFiles() {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare && navigator.canShare({ files: [new File([""], "clip.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
}

type ShareState = { id: number; pct: number | null; file: File | null };

/*
 * Layout of the review window, by screen:
 *   phones, tablets (portrait)  one column that scrolls as a whole: video, details, then Publish / Edit.
 *                               Previous / Next stay pinned at the bottom, the close button at the top.
 *   landscape phones (`short:`) video on the left at full height, a scrolling panel beside it.
 *   laptops and up (`lg:`)      video on the left, panel on the right: its header stays, its body scrolls.
 * `--ph` is the height of the video frame; everything else is sized from it.
 * Where `short:` and `lg:` both match (a wide but very low window) `short:` wins: Tailwind emits it later.
 */
const FRAME_VARS = cn(
  "[--ph:min(44dvh,26rem)] sm:[--ph:min(48dvh,34rem)]",
  "lg:[--ph:min(76dvh,47.5rem,calc(100dvh_-_8rem),calc(81.8vw_-_15.7rem))] 2xl:[--ph:min(76dvh,52rem,calc(100dvh_-_8rem))]",
  "short:[--ph:calc(100dvh_-_1.25rem)]",
);

const NAV_ARROW = "absolute top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 transition outline-none hover:bg-white/20 focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-95 disabled:pointer-events-none disabled:opacity-20 lg:grid short:hidden";

export function ClipStudio({ clips, index, onOpen, onClose, onChange }: {
  clips: Clip[];
  /** position of the open clip in `clips`; -1 (or null) when the studio is closed */
  index: number | null;
  /** step to another clip of `clips` */
  onOpen: (id: number) => void;
  onClose: () => void;
  onChange: (c: Clip) => void;
}) {
  const clip = index != null && index >= 0 ? clips[index] ?? null : null;
  const at = clip ? (index as number) : -1;
  const { data: kit, error: kitError, mutate: mutateKit } = useSWR<PublishKit>(clip ? `/api/clips/${clip.id}/kit` : null, fetcher, { revalidateOnFocus: false });
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [tab, setTab] = useState<"publish" | "edit">("publish");
  const [form, setForm] = useState<FormState>({ title: "", hook: "", description: "", tags: "" });
  const [saving, setSaving] = useState<"save" | "render" | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareable] = useState(canShareFiles);
  const shareAbort = useRef<AbortController | null>(null);
  const seq = useRef(new Map<string, number>());
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const clipId = clip?.id;
  useEffect(() => {
    if (clip) setForm(formOf(clip));
    // a new clip starts at the top, with its video in view
    for (const el of [scroller.current, panel.current, body.current]) el?.scrollTo({ top: 0 });
    // leaving a clip cancels a video that was still being fetched for sharing
    return () => shareAbort.current?.abort();
  }, [clipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const prev = at > 0 ? clips[at - 1] : null;
  const next = at >= 0 && at < clips.length - 1 ? clips[at + 1] : null;
  const prevId = prev?.id;
  const nextId = next?.id;
  const nextThumb = next?.thumb_url;

  // warm up the next clip's poster and captions (small), never its video (big)
  useEffect(() => {
    if (nextId == null) return;
    if (nextThumb) new Image().src = nextThumb;
    preload(`/api/clips/${nextId}/kit`, fetcher).catch(() => {});
  }, [nextId, nextThumb]);

  const go = useCallback((d: number) => {
    const id = d < 0 ? prevId : nextId;
    if (id != null) onOpen(id);
  }, [prevId, nextId, onOpen]);

  const isOpen = !!clip;
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault(); // otherwise a focused video also seeks
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isOpen, go]);

  if (!clip) return null;
  const k = kit?.[platform];
  const isPosted = !!clip.posted?.[platform];
  const shareNow = share && share.id === clip.id ? share : null;
  const dirty = form.title !== clip.title || form.hook !== clip.hook || form.description !== clip.description || form.tags !== clip.hashtags.join(" ");

  /** Paint the change first, then tell the server. Only the latest answer for a clip is applied. */
  async function optimistic(key: string, target: Clip, patched: Clip, send: () => Promise<Clip>) {
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
  }

  function review(to: Clip["review_status"]) {
    const target = clip!;
    const status = target.review_status === to ? "pending" : to;
    void optimistic(`review:${target.id}`, target, { ...target, review_status: status }, () => api.updateClip(target.id, { review_status: status }));
  }

  async function togglePosted() {
    const target = clip!;
    const posted = { ...target.posted };
    if (isPosted) delete posted[platform];
    else posted[platform] = new Date().toISOString();
    // the server also approves a clip the moment it is marked as posted
    const review_status = !isPosted && target.review_status === "pending" ? "approved" : target.review_status;
    const ok = await optimistic(`posted:${target.id}:${platform}`, target, { ...target, posted, review_status }, () => api.markPosted(target.id, platform, !isPosted));
    if (ok && !isPosted) toast.success(`Marked as posted on ${PLATFORM_LABEL[platform]}`);
  }

  async function save(rerender: boolean) {
    const target = clip!;
    setSaving(rerender ? "render" : "save");
    try {
      const saved = await api.updateClip(target.id, {
        title: form.title, hook: form.hook, description: form.description, hashtags: form.tags.split(/[\s,]+/).filter(Boolean),
      });
      onChange(saved);
      setForm(formOf(saved));
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

  /** Step 1 of sharing: fetch the video, showing how far along it is. */
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

  /** Step 2: open the phone's share sheet. Must run inside a tap, or the browser refuses. */
  async function openShareSheet(file: File, fromTap: boolean) {
    const text = k?.caption ?? clip!.title;
    void copyText(text); // not awaited: the share sheet has to open while the tap is still fresh
    try {
      await navigator.share({ files: [file], text });
      toast.success("Caption copied too. Paste it in the app.");
    } catch (e) {
      const name = (e as Error).name;
      if (name === "AbortError") return; // closed the share sheet
      if (name === "NotAllowedError" && !fromTap) return; // the tap got too old while loading: the button now says "Share now"
      toast.error("Could not open sharing", { description: "Use Download instead, then post from your gallery." });
    }
  }

  async function onShare() {
    if (shareNow?.file) return void openShareSheet(shareNow.file, true);
    const file = await fetchForShare(clip!);
    // a quick fetch: the tap still counts, so go straight to the share sheet
    if (file && navigator.userActivation?.isActive) void openShareSheet(file, false);
  }

  const counter = `${at + 1} / ${clips.length}`;
  const meta = `Clip ${at + 1} of ${clips.length} · ${fmtDuration(clip.start)}–${fmtDuration(clip.end)} · ${Math.round(clip.duration)}s`;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-stretch justify-center outline-none sm:inset-4 lg:inset-8 lg:items-center short:inset-0 short:items-stretch"
          // this box is wider than the card on big screens: a click beside the card is a click on the backdrop
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

            {/* phones and tablets: a slim bar that stays put, so the close button never covers what you scroll */}
            <div className="box-content flex h-13 shrink-0 items-center border-b border-white/10 pt-[env(safe-area-inset-top)] pr-14 pl-4 text-sm text-muted-foreground lg:hidden short:hidden">
              <span className="min-w-0 truncate">{meta}</span>
            </div>

            <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:flex-row lg:overflow-hidden short:flex-row short:overflow-hidden">
              {/* player */}
              <div
                className="relative flex shrink-0 touch-pan-y items-center justify-center bg-black/40 px-4 py-3 sm:p-4 lg:w-[46%] lg:p-8 short:w-auto short:p-2.5 short:pl-[max(0.625rem,env(safe-area-inset-left))]"
                onTouchStart={(e) => {
                  // swipe left / right on the video for the next / previous clip (not on its seek bar)
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
                  className="relative aspect-[9/16] h-(--ph) overflow-hidden rounded-[1.625rem] bg-black shadow-2xl ring-4 ring-zinc-800 short:rounded-2xl short:ring-2"
                >
                  <video src={clip.video_url ?? undefined} poster={clip.thumb_url ?? undefined} controls autoPlay playsInline preload="auto" className="h-full w-full object-contain" />
                </motion.div>
                <button type="button" onClick={() => go(1)} disabled={!next} aria-label="Next clip" title="Next clip (right arrow key)" className={cn(NAV_ARROW, "right-2")}><ChevronRight /></button>
              </div>

              {/* side: details + Publish / Edit, then Previous / Next */}
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
                          // the ready-made captions did not load: the clip's own text still works
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
                            <a href={api.clipDownloadUrl(clip.id)} download><Download /> Download</a>
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
                      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) void save(false); }}>
                        <label className="text-xs text-muted-foreground">Post title / first line
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">On-screen hook title (used by the hook-card style)
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">Description
                          <Textarea className="mt-1.5 text-foreground pointer-coarse:text-base" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                        </label>
                        <label className="text-xs text-muted-foreground">Hashtags
                          <Input className="mt-1.5 text-foreground pointer-coarse:h-11 pointer-coarse:text-base" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="#money #mindset" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                        </label>
                        <div className="mt-1 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                          <Button type="submit" className="pointer-coarse:h-11" disabled={!dirty || !!saving}>
                            {saving === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save
                          </Button>
                          <Button type="button" variant="secondary" className="pointer-coarse:h-11" disabled={!!saving} onClick={() => save(true)}>
                            {saving === "render" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Save & re-render
                          </Button>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">Save changes the text you copy when you post. Save & re-render also makes the video again, for a new on-screen hook title.</p>
                        <details className="mt-1 rounded-xl border border-white/10 text-sm">
                          <summary className="flex min-h-10 items-center px-3 text-muted-foreground select-none">What is said in this clip</summary>
                          <p className="px-3 pb-3 leading-relaxed wrap-anywhere whitespace-pre-wrap text-muted-foreground">{clip.transcript || "No speech was found in this clip."}</p>
                        </details>
                      </form>
                    )}
                  </div>
                </div>

                {/* Previous / Next: always in reach on touch screens (the side arrows need a wide screen) */}
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
