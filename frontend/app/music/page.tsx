"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { Check, Film, Loader2, Music2, Pencil, RotateCw, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, fetcher, type BrollClip, type MusicTrack } from "@/lib/api";
import { fmtDuration } from "@/lib/utils";

const pollWhileAnalyzing = (list?: MusicTrack[]) => (list?.some((t) => !t.analyzed) ? 2000 : 0);

function BeatTimeline({ track, onSetDrop }: { track: MusicTrack; onSetDrop: (sec: number) => void }) {
  const dur = track.duration || 0;
  if (!track.analyzed || dur <= 0) return null;
  const beats = (track.beats ?? []).filter((b) => b >= 0 && b <= dur).slice(0, 120);
  const dropPct = track.drop_time != null ? Math.min(100, Math.max(0, (track.drop_time / dur) * 100)) : null;

  return (
    <div
      className="relative mt-2 h-6 w-full cursor-pointer overflow-hidden rounded-lg border border-white/10 bg-black/30"
      title="Click anywhere on the bar to move the drop timestamp"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onSetDrop(Number((frac * dur).toFixed(2)));
      }}
    >
      {beats.map((b, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-1.5 bottom-1.5 w-px bg-white/15"
          style={{ left: `${(b / dur) * 100}%` }}
        />
      ))}
      {dropPct != null && (
        <span
          aria-label={`Drop at ${fmtDuration(track.drop_time)}`}
          className="absolute inset-y-0 w-1 -translate-x-1/2 bg-emerald-400 shadow-[0_0_8px_#34d399]"
          style={{ left: `${dropPct}%` }}
        />
      )}
      <span className="pointer-events-none absolute right-2 bottom-0.5 text-[10px] text-muted-foreground">
        Click bar to move drop
      </span>
    </div>
  );
}

function MusicAndBrollView() {
  const initialTab = useSearchParams().get("tab") === "broll" ? "broll" : "music";
  const [tab, setTab] = useState<"music" | "broll">(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const { data: tracks, error, mutate } = useSWR<MusicTrack[]>("/api/music", fetcher, { refreshInterval: pollWhileAnalyzing, errorRetryInterval: 2000 });
  const { data: broll, error: brollError, mutate: mutateBroll } = useSWR<BrollClip[]>("/api/broll", fetcher);

  const input = useRef<HTMLInputElement>(null);
  const brollInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [brollUpload, setBrollUpload] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number[]>([]);
  const [removingBroll, setRemovingBroll] = useState<number[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const busy = upload !== null;
  const brollBusy = brollUpload !== null;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setUpload(0);
    try {
      await api.uploadMusic(list, setUpload);
      toast.success(list.length > 1 ? `${list.length} songs added` : "Song added", { description: "Finding the tempo and the drop now." });
      mutate();
    } catch (e) {
      toast.error("Could not add the songs", { description: (e as Error).message });
    } finally {
      setUpload(null);
      if (input.current) input.current.value = "";
    }
  }

  async function addBroll(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setBrollUpload(0);
    try {
      await api.uploadBroll(list, setBrollUpload);
      toast.success(list.length > 1 ? `${list.length} B-roll clips added` : "B-roll clip added");
      mutateBroll();
    } catch (e) {
      toast.error("Could not add B-roll clip", { description: (e as Error).message });
    } finally {
      setBrollUpload(null);
      if (brollInput.current) brollInput.current.value = "";
    }
  }

  async function remove(t: MusicTrack) {
    if (!confirm(`Delete "${t.name}"?`)) return;
    setRemoving((r) => [...r, t.id]);
    try {
      await mutate(
        async (list) => {
          await api.deleteMusic(t.id);
          return list?.filter((x) => x.id !== t.id);
        },
        { optimisticData: (list) => (list ?? []).filter((x) => x.id !== t.id), rollbackOnError: true, revalidate: false },
      );
    } catch (e) {
      toast.error("Could not delete the song", { description: (e as Error).message });
    } finally {
      setRemoving((r) => r.filter((id) => id !== t.id));
    }
  }

  async function removeBroll(b: BrollClip) {
    if (!confirm(`Delete B-roll "${b.name}"?`)) return;
    setRemovingBroll((r) => [...r, b.id]);
    try {
      await api.deleteBroll(b.id);
      await mutateBroll((list) => list?.filter((x) => x.id !== b.id), { revalidate: false });
    } catch (e) {
      toast.error("Could not delete B-roll", { description: (e as Error).message });
    } finally {
      setRemovingBroll((r) => r.filter((id) => id !== b.id));
    }
  }

  async function saveName(t: MusicTrack) {
    try {
      const updated = await api.updateMusic(t.id, { name: editName });
      await mutate((list) => list?.map((x) => (x.id === t.id ? updated : x)), { revalidate: false });
      setEditingId(null);
    } catch (e) {
      toast.error("Could not rename track", { description: (e as Error).message });
    }
  }

  async function setDrop(t: MusicTrack, sec: number) {
    try {
      const updated = await api.updateMusic(t.id, { drop_time: sec });
      await mutate((list) => list?.map((x) => (x.id === t.id ? updated : x)), { revalidate: false });
      toast.success(`Drop moved to ${fmtDuration(sec)}`);
    } catch (e) {
      toast.error("Could not update drop", { description: (e as Error).message });
    }
  }

  async function reanalyze(t: MusicTrack) {
    try {
      const updated = await api.reanalyzeMusic(t.id);
      await mutate((list) => list?.map((x) => (x.id === t.id ? updated : x)), { revalidate: false });
    } catch (e) {
      toast.error("Could not re-analyze", { description: (e as Error).message });
    }
  }

  const pick = () => input.current?.click();
  const pickBroll = () => brollInput.current?.click();
  const uploadLabel = busy ? (upload! >= 100 ? "Saving…" : `Uploading ${Math.floor(upload!)}%`) : "Upload songs";
  const brollLabel = brollBusy ? (brollUpload! >= 100 ? "Saving…" : `Uploading ${Math.floor(brollUpload!)}%`) : "Upload B-roll";

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Audio & B-Roll library"
        description="Background songs are checked for tempo & beat drops. B-roll clips loop on the bottom half in Speaker + B-Roll split layouts."
        actions={
          tab === "music" ? (
            <>
              <Button onClick={pick} disabled={busy} className="max-sm:w-full pointer-coarse:h-11">
                {busy ? <Loader2 className="animate-spin" /> : <Upload />} <span className="tabular-nums">{uploadLabel}</span>
              </Button>
              <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => add(e.target.files)} />
            </>
          ) : (
            <>
              <Button onClick={pickBroll} disabled={brollBusy} className="max-sm:w-full pointer-coarse:h-11">
                {brollBusy ? <Loader2 className="animate-spin" /> : <Upload />} <span className="tabular-nums">{brollLabel}</span>
              </Button>
              <input ref={brollInput} type="file" accept="video/*" multiple hidden onChange={(e) => addBroll(e.target.files)} />
            </>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "music" | "broll")} className="gap-4">
        <TabsList>
          <TabsTrigger value="music"><Music2 /> Music ({tracks?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="broll"><Film /> B-Roll clips ({broll?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="music">
          <p className="mb-4 text-xs text-muted-foreground">Use music you have the rights to (royalty-free or licensed). Click any beat bar to fine-tune where the drop lands.</p>
          {!tracks ? (
            error ? (
              <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                <p>Your songs did not load. Check your connection.</p>
                <Button variant="outline" className="mt-3 pointer-coarse:h-11" onClick={() => mutate()}>Try again</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading songs">
                {[0, 1, 2].map((k) => <div key={k} className="skeleton h-[5.5rem] rounded-2xl" />)}
              </div>
            )
          ) : tracks.length === 0 ? (
            <div className="glass flex flex-col items-center rounded-3xl border border-dashed px-6 py-10 text-center sm:py-12">
              <Music2 className="mb-3 size-7 text-primary" aria-hidden />
              <p className="font-medium">No songs yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">Add MP3, WAV or M4A files. You can then pick them in the style step of any project.</p>
              <Button variant="outline" className="mt-4 pointer-coarse:h-11" onClick={pick} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Upload />} <span className="tabular-nums">{uploadLabel}</span>
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {tracks.map((t) => (
                <li key={t.id} className="glass rounded-2xl border p-3.5 shadow-sm">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
                    <Music2 className="size-5 shrink-0 text-primary" aria-hidden />
                    <div className="min-w-0">
                      {editingId === t.id ? (
                        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void saveName(t); }}>
                          <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8 text-xs" autoFocus />
                          <Button type="submit" size="sm" className="h-8 px-2"><Check className="size-3.5" /></Button>
                        </form>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium" title={t.name}>{t.name}</span>
                          <button type="button" onClick={() => { setEditingId(t.id); setEditName(t.name); }} aria-label="Rename track" className="text-muted-foreground hover:text-foreground">
                            <Pencil className="size-3" />
                          </button>
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="tabular-nums">{fmtDuration(t.duration)}</span>
                        {t.analyzed ? (
                          <>
                            <Badge variant="secondary">{t.bpm ? `${Math.round(t.bpm)} BPM` : "Tempo unknown"}</Badge>
                            {t.drop_time != null && <Badge variant="success">Drop at {fmtDuration(t.drop_time)}</Badge>}
                          </>
                        ) : (
                          <Badge variant="warning"><Loader2 className="animate-spin" /> Checking the beat</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 sm:order-last">
                      <Button variant="ghost" size="icon" aria-label={`Re-analyze ${t.name}`} title="Re-analyze beat & drop" onClick={() => reanalyze(t)}>
                        <RotateCw className="size-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" aria-label={`Delete ${t.name}`} title="Delete song" disabled={removing.includes(t.id)} onClick={() => remove(t)}
                        className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
                      >
                        {removing.includes(t.id) ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </div>
                    <audio src={t.url} controls preload="none" aria-label={`Play ${t.name}`} className="col-span-3 h-10 w-full sm:col-span-1 sm:h-9 sm:w-60 lg:w-72" />
                  </div>
                  <BeatTimeline track={t} onSetDrop={(sec) => void setDrop(t, sec)} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="broll">
          <p className="mb-4 text-xs text-muted-foreground">Upload looping background clips (gameplay, kinetic visuals, studio footage). Audio is automatically muted during split rendering.</p>
          {!broll ? (
            brollError ? (
              <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                <p>Could not load B-roll clips.</p>
                <Button variant="outline" className="mt-3" onClick={() => mutateBroll()}>Try again</Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[0, 1].map((k) => <div key={k} className="skeleton h-40 rounded-2xl" />)}
              </div>
            )
          ) : broll.length === 0 ? (
            <div className="glass flex flex-col items-center rounded-3xl border border-dashed px-6 py-10 text-center sm:py-12">
              <Film className="mb-3 size-7 text-primary" aria-hidden />
              <p className="font-medium">No B-roll clips yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">Upload MP4/MOV/WEBM clips to use with the Speaker + B-Roll split layout.</p>
              <Button variant="outline" className="mt-4 pointer-coarse:h-11" onClick={pickBroll} disabled={brollBusy}>
                {brollBusy ? <Loader2 className="animate-spin" /> : <Upload />} <span className="tabular-nums">{brollLabel}</span>
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {broll.map((b) => (
                <div key={b.id} className="glass overflow-hidden rounded-2xl border p-3">
                  <video src={b.url} muted loop playsInline controls preload="metadata" className="aspect-video w-full rounded-xl bg-black object-cover" />
                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{b.name}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {[fmtDuration(b.duration), b.width && b.height ? `${b.width}×${b.height}` : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" disabled={removingBroll.includes(b.id)} onClick={() => removeBroll(b)} className="text-muted-foreground hover:text-destructive">
                      {removingBroll.includes(b.id) ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function MusicPage() {
  return (
    <Suspense fallback={<div className="skeleton h-40 max-w-4xl rounded-3xl" />}>
      <MusicAndBrollView />
    </Suspense>
  );
}
