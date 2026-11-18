"use client";

import Link from "next/link";
import { use, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { ArrowLeft, CheckCheck, Loader2, Palette, Rocket } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { ClipCard } from "@/components/clip-card";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { api, fetcher, type Clip, type GenerationSettings, type Project } from "@/lib/api";
import { fmtDuration } from "@/lib/utils";

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const active = (p?: Project) => p?.status === "queued" || p?.status === "processing";
  const { data: project, mutate: mutateProject } = useSWR<Project>(`/api/projects/${id}`, fetcher, {
    refreshInterval: (p) => (active(p) ? 1500 : 0),
  });
  const { data: clips, mutate: mutateClips } = useSWR<Clip[]>(`/api/projects/${id}/clips`, fetcher, {
    refreshInterval: (list?: Clip[]): number =>
      active(project) || list?.some((c) => c.status === "pending" || c.status === "rendering") ? 3000 : 0,
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [restyle, setRestyle] = useState<GenerationSettings | null>(null);

  if (!project) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const ready = clips?.filter((c) => c.status === "ready") ?? [];
  const toggle = (cid: number, v: boolean) => setSelected((s) => (v ? [...s, cid] : s.filter((x) => x !== cid)));
  const updateClip = (c: Clip) => mutateClips((list) => list?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Dashboard</Link>
      <PageHeader
        title={project.name}
        description={`${fmtDuration(project.duration)} source · ${project.settings.editing_style.replaceAll("_", " ")} · ${project.settings.caption_style.replaceAll("_", " ")} captions`}
        actions={
          <>
            <Button variant="outline" disabled={active(project)} onClick={() => setRestyle(project.settings)}><Palette /> Re-generate with new style</Button>
            <Button variant="outline" disabled={!ready.length} onClick={() => setSelected(selected.length === ready.length ? [] : ready.map((c) => c.id))}>
              <CheckCheck /> {selected.length === ready.length && ready.length ? "Clear selection" : "Select all"}
            </Button>
            <Button disabled={!selected.length} onClick={() => setScheduleOpen(true)}><Rocket /> Publish {selected.length || ""}</Button>
          </>
        }
      />

      {(active(project) || project.status === "failed") && (
        <Card className="mb-6 py-4">
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <StatusBadge status={project.status} />
              {active(project) && <Loader2 className="size-4 animate-spin text-primary" />}
              <span>{project.stage}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{Math.round(project.progress * 100)}%</span>
            </div>
            <Progress value={project.progress * 100} />
            {project.error && <p className="text-sm text-destructive">{project.error}</p>}
          </CardContent>
        </Card>
      )}

      {clips && clips.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {clips.map((c) => (
            <ClipCard key={c.id} clip={c} selected={selected.includes(c.id)} onSelect={(v) => toggle(c.id, v)} onChange={updateClip} />
          ))}
        </div>
      ) : (
        !active(project) && <p className="text-sm text-muted-foreground">No clips yet.</p>
      )}

      <ScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} clipIds={selected} onDone={() => { setSelected([]); mutateClips(); }} />

      <Dialog open={!!restyle} onOpenChange={(o) => !o && setRestyle(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Re-generate with a new style</DialogTitle></DialogHeader>
          {restyle && <StyleSelector value={restyle} onChange={setRestyle} />}
          <DialogFooter>
            <Button
              onClick={async () => {
                try {
                  await api.regenerate(project.id, restyle!);
                  setRestyle(null);
                  mutateProject();
                  mutateClips();
                  toast.success("Re-generating. The transcript is reused, so this is quicker.");
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Re-generate {restyle?.clip_count} clips
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
