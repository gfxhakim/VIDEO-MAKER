"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Loader2, Music2, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, fetcher, type MusicTrack } from "@/lib/api";
import { fmtDuration } from "@/lib/utils";

export default function MusicPage() {
  const { data: tracks, mutate } = useSWR<MusicTrack[]>("/api/music", fetcher, {
    refreshInterval: (d) => (d?.some((t) => !t.analyzed) ? 2000 : 0),
  });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      await api.uploadMusic(Array.from(files));
      toast.success(`${files.length} song${files.length > 1 ? "s" : ""} added. Analyzing beats…`);
      mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Music library"
        description="Upload background songs. Each one is analyzed for tempo and its drop, so the drop can land on a clip's hook."
        actions={
          <>
            <Button onClick={() => input.current?.click()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload songs</Button>
            <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => upload(e.target.files)} />
          </>
        }
      />
      <p className="mb-4 text-xs text-muted-foreground">Use music you have the rights to (royalty-free or licensed). Platforms may mute or block clips with copyrighted songs.</p>
      {!tracks ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tracks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground"><Music2 className="mx-auto mb-2 size-7" />No songs yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {tracks.map((t) => (
            <Card key={t.id} className="py-3">
              <CardContent className="flex flex-wrap items-center gap-4 px-4">
                <Music2 className="size-5 text-primary" />
                <div className="min-w-40 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{fmtDuration(t.duration)}</div>
                </div>
                {t.analyzed ? (
                  <div className="flex gap-2">
                    <Badge variant="secondary">{t.bpm ? Math.round(t.bpm) : "?"} BPM</Badge>
                    <Badge variant="success">drop @ {fmtDuration(t.drop_time)}</Badge>
                  </div>
                ) : (
                  <Badge variant="warning"><Loader2 className="animate-spin" /> analyzing</Badge>
                )}
                <audio src={t.url} controls preload="none" className="h-8 w-56" />
                <Button variant="ghost" size="icon" onClick={async () => { await api.deleteMusic(t.id); mutate(); }}><Trash2 /></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
