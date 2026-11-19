"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Loader2, Music2, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, fetcher, type MusicTrack } from "@/lib/api";
import { fmtDuration } from "@/lib/utils";

// Module scope, so SWR keeps one timer instead of restarting it on every render.
const pollWhileAnalyzing = (list?: MusicTrack[]) => (list?.some((t) => !t.analyzed) ? 2000 : 0);

export default function MusicPage() {
  const { data: tracks, error, mutate } = useSWR<MusicTrack[]>("/api/music", fetcher, { refreshInterval: pollWhileAnalyzing, errorRetryInterval: 2000 });
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<number | null>(null); // percent sent, null when idle
  const [removing, setRemoving] = useState<number[]>([]);
  const busy = upload !== null;

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

  async function remove(t: MusicTrack) {
    if (!confirm(`Delete "${t.name}"?`)) return;
    setRemoving((r) => [...r, t.id]);
    try {
      // the row goes away at once and comes back if the server says no
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

  const pick = () => input.current?.click();
  const uploadLabel = busy ? (upload! >= 100 ? "Saving…" : `Uploading ${Math.floor(upload!)}%`) : "Upload songs";

  return (
    // reads better narrow: capped and left-aligned, so the heading starts where it does on every other page
    <div className="max-w-4xl">
      <PageHeader
        title="Music library"
        description="Upload background songs. Each one is checked for its tempo and its drop, so the drop can land on a clip's hook."
        actions={
          <>
            <Button onClick={pick} disabled={busy} className="max-sm:w-full pointer-coarse:h-11">
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} <span className="tabular-nums">{uploadLabel}</span>
            </Button>
            <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => add(e.target.files)} />
          </>
        }
      />
      <p className="mb-4 text-xs text-muted-foreground">Use music you have the rights to (royalty-free or licensed). Platforms may mute or block clips with copyrighted songs.</p>

      {!tracks ? (
        error ? (
          <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p>Your songs did not load. Check your connection.</p>
            <Button variant="outline" className="mt-3 pointer-coarse:h-11" onClick={() => mutate()}>Try again</Button>
          </div>
        ) : (
          // same height and gap as the real rows, so the page does not jump
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading songs">
            {[0, 1, 2].map((k) => (
              <div key={k} className="skeleton h-[7.25rem] rounded-2xl sm:h-[4.25rem]" />
            ))}
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
        <ul className="flex flex-col gap-2">
          {tracks.map((t) => (
            // phones: name and delete on the first line, the player full width under it. From sm: one line.
            <li key={t.id} className="glass grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-2xl border py-2.5 pr-2 pl-4 shadow-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:gap-x-4 sm:pr-3">
              <Music2 className="size-5 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={t.name}>{t.name}</div>
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
              <Button
                variant="ghost" size="icon" aria-label={`Delete ${t.name}`} title="Delete song" disabled={removing.includes(t.id)} onClick={() => remove(t)}
                className="text-muted-foreground hover:text-destructive sm:order-last pointer-coarse:size-11"
              >
                {removing.includes(t.id) ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
              <audio src={t.url} controls preload="none" aria-label={`Play ${t.name}`} className="col-span-3 h-10 w-[calc(100%-0.5rem)] sm:col-span-1 sm:h-9 sm:w-60 lg:w-72" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
