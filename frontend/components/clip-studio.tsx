"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  Check, ChevronLeft, ChevronRight, Copy, Download, Loader2, RefreshCw, Save, Share2, ThumbsDown, ThumbsUp, X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ScoreRing } from "@/components/clip-card";
import { PLATFORMS, PLATFORM_LABEL, PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, fetcher, type Clip, type Platform, type PublishKit } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

function CopyBlock({ label, text, mono = false }: { label: string; text: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group rounded-xl border border-white/10 bg-white/[.03]">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          }}
          className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs transition", done ? "bg-emerald-500/15 text-emerald-400" : "text-muted-foreground hover:bg-white/5 hover:text-foreground")}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={cn("px-3 pt-1 pb-3 text-sm whitespace-pre-wrap", mono && "font-mono text-xs")}>{text}</p>
    </div>
  );
}

const SIGNALS: [string, string][] = [["hook", "Hook"], ["energy", "Energy"], ["emotion", "Emotion"], ["density", "Pace"], ["spikes", "Reactions"], ["action", "Action"]];

export function ClipStudio({ clips, index, onIndex, onClose, onChange }: {
  clips: Clip[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChange: (c: Clip) => void;
}) {
  const clip = index != null ? clips[index] : null;
  const { data: kit, mutate: mutateKit } = useSWR<PublishKit>(clip ? `/api/clips/${clip.id}/kit` : null, fetcher);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [tab, setTab] = useState<"publish" | "edit">("publish");
  const [form, setForm] = useState({ title: "", hook: "", description: "", tags: "" });
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    if (clip) setForm({ title: clip.title, hook: clip.hook, description: clip.description, tags: clip.hashtags.join(" ") });
  }, [clip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((d: number) => {
    if (index == null) return;
    const n = index + d;
    if (n >= 0 && n < clips.length) onIndex(n);
  }, [index, clips.length, onIndex]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA/)) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);

  if (!clip) return null;
  const k = kit?.[platform];
  const isPosted = !!clip.posted?.[platform];

  async function update(body: Parameters<typeof api.updateClip>[1]) {
    setBusy(true);
    try {
      const c = await api.updateClip(clip!.id, body);
      onChange(c);
      mutateKit();
      return c;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    // Mobile: hand the video straight to TikTok / Instagram / YouTube via the share sheet.
    setSharing(true);
    try {
      const blob = await (await fetch(clip!.video_url!)).blob();
      const file = new File([blob], `${clip!.title.slice(0, 40) || "clip"}.mp4`, { type: "video/mp4" });
      const text = k?.caption ?? clip!.title;
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.clipboard.writeText(text).catch(() => {});
        await navigator.share({ files: [file], text });
        toast.success("Caption copied too: paste it in the app");
      } else {
        toast.info("Sharing files isn't supported in this browser. Use Download instead.");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error((e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  async function togglePosted() {
    try {
      onChange(await api.markPosted(clip!.id, platform, !isPosted));
      if (!isPosted) toast.success(`Marked as posted on ${PLATFORM_LABEL[platform]}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <DialogPrimitive.Root open={index != null} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 flex items-stretch justify-center outline-none sm:inset-4 lg:inset-8">
          <DialogPrimitive.Title className="sr-only">{clip.title}</DialogPrimitive.Title>
          <div className="glass relative flex w-full max-w-6xl flex-col overflow-hidden border border-white/10 shadow-2xl sm:rounded-3xl lg:flex-row">
            <button onClick={onClose} className="absolute top-3 right-3 z-20 grid size-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70" aria-label="Close"><X className="size-4" /></button>

            {/* player */}
            <div className="relative flex shrink-0 items-center justify-center bg-black/40 p-4 lg:w-[46%] lg:p-8">
              <button onClick={() => go(-1)} disabled={index === 0} className="absolute left-2 z-10 hidden size-10 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20 disabled:opacity-20 sm:grid"><ChevronLeft /></button>
              <AnimatePresence mode="wait">
                <motion.div key={clip.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.18 }}
                  className="relative aspect-[9/16] h-[42vh] overflow-hidden rounded-[26px] border-4 border-zinc-800 bg-black shadow-2xl sm:h-[52vh] lg:h-[min(76vh,760px)]">
                  <video src={clip.video_url ?? undefined} poster={clip.thumb_url ?? undefined} controls autoPlay playsInline className="h-full w-full object-cover" />
                </motion.div>
              </AnimatePresence>
              <button onClick={() => go(1)} disabled={index === clips.length - 1} className="absolute right-2 z-10 hidden size-10 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20 disabled:opacity-20 sm:grid"><ChevronRight /></button>
            </div>

            {/* side panel */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-white/10 p-5 pr-14">
                <div className="flex items-start gap-3">
                  <ScoreRing score={clip.score} size={46} />
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">Clip #{clip.rank} of {clips.length} · {fmtDuration(clip.start)}–{fmtDuration(clip.end)} · {Math.round(clip.duration)}s</div>
                    <h2 className="mt-0.5 line-clamp-2 text-lg leading-snug font-semibold">{clip.title}</h2>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
                  {SIGNALS.map(([key, label]) => {
                    const v = Number(clip.score_breakdown[key] ?? 0);
                    return (
                      <div key={key} className="text-[10px] text-muted-foreground">
                        <div className="mb-1">{label}</div>
                        <div className="h-1 overflow-hidden rounded-full bg-white/10"><motion.div initial={{ width: 0 }} animate={{ width: `${v * 100}%` }} className="bg-brand h-full" /></div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={clip.review_status === "approved" ? "default" : "outline"} onClick={() => update({ review_status: clip.review_status === "approved" ? "pending" : "approved" })} disabled={busy}>
                    <ThumbsUp /> {clip.review_status === "approved" ? "Approved" : "Approve"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => update({ review_status: clip.review_status === "rejected" ? "pending" : "rejected" })} disabled={busy}>
                    <ThumbsDown /> {clip.review_status === "rejected" ? "Rejected" : "Reject"}
                  </Button>
                  <div className="ml-auto flex rounded-lg bg-white/5 p-0.5 text-sm">
                    {(["publish", "edit"] as const).map((t) => (
                      <button key={t} onClick={() => setTab(t)} className={cn("relative rounded-md px-3 py-1 capitalize", tab === t ? "text-foreground" : "text-muted-foreground")}>
                        {tab === t && <motion.span layoutId="studio-tab" className="absolute inset-0 rounded-md bg-white/10" />}
                        <span className="relative">{t}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {tab === "publish" ? (
                  <div className="flex flex-col gap-4">
                    <div className="no-scrollbar flex gap-2 overflow-x-auto">
                      {PLATFORMS.map((p) => (
                        <button key={p} onClick={() => setPlatform(p)} className={cn("flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition", platform === p ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/5")}>
                          <PlatformIcon platform={p} className="size-5 text-[8px]" /> {PLATFORM_LABEL[p]}
                          {clip.posted?.[p] && <Check className="size-3.5 text-emerald-400" />}
                        </button>
                      ))}
                    </div>
                    {!k ? (
                      <div className="skeleton h-40 rounded-xl" />
                    ) : (
                      <>
                        {platform === "youtube" && <CopyBlock label="Title" text={k.title} />}
                        <CopyBlock label={platform === "youtube" ? "Description" : "Caption"} text={k.caption} />
                        <CopyBlock label="Hashtags" text={k.hashtags.join(" ")} />
                      </>
                    )}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <Button asChild variant="secondary"><a href={api.clipDownloadUrl(clip.id)}><Download /> Download</a></Button>
                      <Button variant="secondary" onClick={share} disabled={sharing}>{sharing ? <Loader2 className="animate-spin" /> : <Share2 />} Share to app</Button>
                      <Button onClick={togglePosted} variant={isPosted ? "outline" : "default"} className="col-span-2 sm:col-span-1">
                        <Check /> {isPosted ? "Posted" : "Mark posted"}
                      </Button>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      You post by hand in the {PLATFORM_LABEL[platform]} app, which keeps your accounts safe. On a phone, <b>Share to app</b> sends the video straight to it and copies the caption.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <label className="text-xs text-muted-foreground">Post title / first line
                      <Input className="mt-1.5" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                    </label>
                    <label className="text-xs text-muted-foreground">On-screen hook title (used by the hook-card style)
                      <Input className="mt-1.5" value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value })} />
                    </label>
                    <label className="text-xs text-muted-foreground">Description
                      <Textarea className="mt-1.5" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                    </label>
                    <label className="text-xs text-muted-foreground">Hashtags
                      <Input className="mt-1.5" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="#money #mindset" />
                    </label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={async () => { if (await update({ title: form.title, hook: form.hook, description: form.description, hashtags: form.tags.split(/[\s,]+/).filter(Boolean) })) toast.success("Saved"); }}>
                        <Save /> Save
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={async () => {
                        const c = await update({ title: form.title, hook: form.hook, description: form.description, hashtags: form.tags.split(/[\s,]+/).filter(Boolean) });
                        if (c) { onChange(await api.rerenderClip(clip.id)); toast.success("Re-rendering with your changes"); onClose(); }
                      }}>
                        <RefreshCw /> Save & re-render
                      </Button>
                    </div>
                    <details className="mt-3 rounded-xl border border-white/10 p-3 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Transcript</summary>
                      <p className="mt-2 leading-relaxed whitespace-pre-wrap text-muted-foreground">{clip.transcript || "No speech detected."}</p>
                    </details>
                  </div>
                )}
              </div>
              {/* mobile prev/next */}
              <div className="flex items-center justify-between border-t border-white/10 px-4 py-2 sm:hidden">
                <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => go(-1)}><ChevronLeft /> Prev</Button>
                <span className="text-xs text-muted-foreground">{(index ?? 0) + 1} / {clips.length}</span>
                <Button size="sm" variant="ghost" disabled={index === clips.length - 1} onClick={() => go(1)}>Next <ChevronRight /></Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
