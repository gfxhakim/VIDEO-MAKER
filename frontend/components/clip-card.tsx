"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Download, Flame, Loader2, Pencil, RefreshCw, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, type Clip } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

const SIGNALS: [string, string][] = [
  ["hook", "Hook"],
  ["energy", "Energy"],
  ["emotion", "Emotion"],
  ["density", "Pace"],
  ["spikes", "Spikes"],
  ["action", "Action"],
];

export function ScoreBars({ b }: { b: Clip["score_breakdown"] }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1">
      {SIGNALS.map(([k, label]) => {
        const v = Number(b[k] ?? 0);
        return (
          <div key={k} className="text-[10px] text-muted-foreground">
            <div className="flex justify-between"><span>{label}</span><span>{Math.round(v * 100)}</span></div>
            <div className="h-1 rounded bg-muted"><div className="h-1 rounded bg-primary" style={{ width: `${v * 100}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

export function ClipCard({
  clip,
  selected,
  onSelect,
  onChange,
}: {
  clip: Clip;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  onChange?: (c: Clip) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(clip.title);
  const [hook, setHook] = useState(clip.hook);
  const [desc, setDesc] = useState(clip.description);
  const [tags, setTags] = useState(clip.hashtags.join(" "));
  const [busy, setBusy] = useState(false);

  async function patch(body: Parameters<typeof api.updateClip>[1]) {
    setBusy(true);
    try {
      const c = await api.updateClip(clip.id, body);
      onChange?.(c);
      return c;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(rerender: boolean) {
    const c = await patch({ title, description: desc, hook, hashtags: tags.split(/[\s,]+/).filter(Boolean) });
    if (c && rerender) {
      onChange?.(await api.rerenderClip(clip.id));
      toast.success("Re-rendering with the new hook title");
    }
    setEditing(false);
  }

  const ready = clip.status === "ready";
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card transition-colors", selected && "border-primary ring-1 ring-primary", clip.review_status === "rejected" && "opacity-50")}>
      <div className="relative aspect-[9/16] bg-black">
        {ready && clip.video_url ? (
          <video src={clip.video_url} poster={clip.thumb_url ?? undefined} controls preload="none" playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center p-4 text-center text-xs text-muted-foreground">
            {clip.status === "failed" ? (
              <span className="text-destructive">Render failed<br />{clip.error?.slice(-180)}</span>
            ) : (
              <span className="flex flex-col items-center gap-2"><Loader2 className="size-6 animate-spin text-primary" />{clip.status === "rendering" ? "Rendering…" : "Queued"}</span>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute top-2 left-2 flex gap-1">
          <Badge className="pointer-events-auto gap-1 bg-black/70 text-white"><Flame className="text-orange-400" />{Math.round(clip.score)}</Badge>
          <Badge variant="secondary" className="bg-black/70">#{clip.rank}</Badge>
        </div>
        {onSelect && ready && (
          <div className="absolute top-2 right-2 rounded bg-black/60 p-1">
            <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label="Select clip" />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title" />
            <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="On-screen hook title" />
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Description" />
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#tags separated by spaces" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => save(false)} disabled={busy}><Save /> Save</Button>
              <Button size="sm" variant="secondary" onClick={() => save(true)} disabled={busy}><RefreshCw /> Save + re-render</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="line-clamp-2 text-sm font-medium">{clip.title}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {clip.hashtags.slice(0, 5).map((t) => <span key={t} className="text-[11px] text-primary">{t}</span>)}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {fmtDuration(clip.start)} → {fmtDuration(clip.end)} · {Math.round(clip.duration)}s
                {clip.score_breakdown.layout ? ` · ${String(clip.score_breakdown.layout).replace("_", " ")}` : ""}
              </div>
            </div>
            <ScoreBars b={clip.score_breakdown} />
          </>
        )}
        {!editing && (
          <div className="mt-auto flex items-center gap-1">
            <Button
              size="sm"
              variant={clip.review_status === "approved" ? "default" : "outline"}
              disabled={!ready || busy}
              onClick={() => patch({ review_status: clip.review_status === "approved" ? "pending" : "approved" })}
            >
              <Check /> {clip.review_status === "approved" ? "Approved" : "Approve"}
            </Button>
            <Button size="icon" variant="ghost" className="size-8" title="Reject" disabled={busy}
              onClick={() => patch({ review_status: clip.review_status === "rejected" ? "pending" : "rejected" })}>
              <X />
            </Button>
            <Button size="icon" variant="ghost" className="size-8" title="Edit title & tags" onClick={() => setEditing(true)}><Pencil /></Button>
            {ready && (
              <Button size="icon" variant="ghost" className="ml-auto size-8" title="Download" asChild>
                <a href={api.clipDownloadUrl(clip.id)}><Download /></a>
              </Button>
            )}
            {clip.status === "failed" && (
              <Button size="icon" variant="ghost" className="ml-auto size-8" title="Retry render"
                onClick={async () => onChange?.(await api.rerenderClip(clip.id))}><RefreshCw /></Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
