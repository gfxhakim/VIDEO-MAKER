"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, Download, Loader2, Palette, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { ClipCard } from "@/components/clip-card";
import { ClipStudio } from "@/components/clip-studio";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { api, fetcher, type Clip, type GenerationSettings, type Project } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

const STEPS = ["Fetching", "Transcribing", "Scoring", "Rendering"];

function stepIndex(p: Project) {
  if (p.progress >= 0.7) return 3;
  if (p.progress >= 0.62) return 2;
  if (p.progress >= 0.16) return 1;
  return 0;
}

function ProjectView() {
  const id = useSearchParams().get("id");
  const active = (p?: Project) => p?.status === "queued" || p?.status === "processing";
  const { data: project, mutate: mutateProject } = useSWR<Project>(id ? `/api/projects/${id}` : null, fetcher, {
    refreshInterval: (p) => (active(p) ? 1500 : 0),
  });
  const { data: clips, mutate: mutateClips } = useSWR<Clip[]>(id ? `/api/projects/${id}/clips` : null, fetcher, {
    refreshInterval: (list?: Clip[]): number => (active(project) || list?.some((c) => c.status === "pending" || c.status === "rendering") ? 2500 : 0),
  });
  const [filter, setFilter] = useState<"all" | "approved" | "pending" | "rejected">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [restyle, setRestyle] = useState<GenerationSettings | null>(null);

  const shown = useMemo(() => (clips ?? []).filter((c) => filter === "all" || c.review_status === filter), [clips, filter]);
  const playable = useMemo(() => shown.filter((c) => c.status === "ready"), [shown]);
  if (!project) return <div className="skeleton mx-auto h-40 max-w-7xl rounded-3xl" />;
  const approvedCount = clips?.filter((c) => c.review_status === "approved" && c.status === "ready").length ?? 0;
  const updateClip = (c: Clip) => mutateClips((list) => list?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Studio</Link>
      <PageHeader
        title={project.name}
        description={<span className="capitalize">{fmtDuration(project.duration)} source · {project.settings.editing_style.replaceAll("_", " ")} · {project.settings.caption_style.replaceAll("_", " ")} captions</span>}
        actions={
          <>
            <Button variant="outline" disabled={active(project)} onClick={() => setRestyle(project.settings)}><Palette /> Re-style</Button>
            <Button variant="outline" asChild disabled={!clips?.length}>
              <a href={api.exportZipUrl(project.id, approvedCount ? "approved" : "all")}><Download /> {approvedCount ? `Download ${approvedCount} approved` : "Download all"}</a>
            </Button>
          </>
        }
      />

      {(active(project) || project.status === "failed") && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass mb-8 rounded-3xl border p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge status={project.status} />
            {active(project) && <Loader2 className="size-4 animate-spin text-primary" />}
            <span className="text-sm">{project.stage}</span>
            <span className="text-gradient ml-auto text-2xl font-semibold tabular-nums">{Math.round(project.progress * 100)}%</span>
          </div>
          <Progress value={project.progress * 100} className="h-2.5" />
          <div className="mt-4 grid grid-cols-4 gap-2">
            {STEPS.map((s, i) => {
              const cur = stepIndex(project);
              return (
                <div key={s} className={cn("flex items-center gap-2 text-xs", i <= cur ? "text-foreground" : "text-muted-foreground")}>
                  <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[10px]", i < cur ? "bg-emerald-500 text-white" : i === cur ? "bg-brand text-white" : "bg-white/10")}>{i + 1}</span>
                  <span className="hidden sm:inline">{s}</span>
                </div>
              );
            })}
          </div>
          {project.error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{project.error}</p>}
        </motion.div>
      )}

      {!!clips?.length && (
        <div className="no-scrollbar mb-5 flex gap-2 overflow-x-auto">
          {(["all", "pending", "approved", "rejected"] as const).map((f) => {
            const n = f === "all" ? clips.length : clips.filter((c) => c.review_status === f).length;
            return (
              <button key={f} onClick={() => setFilter(f)} className={cn("relative shrink-0 rounded-full px-4 py-1.5 text-sm capitalize transition", filter === f ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {filter === f && <motion.span layoutId="clip-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" />}
                <span className="relative">{f === "pending" ? "To review" : f} <span className="text-muted-foreground">{n}</span></span>
              </button>
            );
          })}
        </div>
      )}

      {shown.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((c, i) => (
            <ClipCard key={c.id} clip={c} index={i} onChange={updateClip} onOpen={() => setOpen(playable.findIndex((x) => x.id === c.id))} />
          ))}
        </div>
      ) : (
        !active(project) && <div className="glass rounded-3xl border border-dashed p-12 text-center text-sm text-muted-foreground"><Sparkles className="mx-auto mb-2 size-6 text-primary" />Nothing here yet.</div>
      )}

      <ClipStudio clips={playable} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onChange={updateClip} />

      <Dialog open={!!restyle} onOpenChange={(o) => !o && setRestyle(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Re-style this project</DialogTitle></DialogHeader>
          <DialogBody>{restyle && <StyleSelector value={restyle} onChange={setRestyle} />}</DialogBody>
          <DialogFooter>
            <Button className="bg-brand text-white" onClick={async () => {
              try {
                await api.regenerate(project.id, restyle!);
                setRestyle(null);
                mutateProject();
                mutateClips();
                toast.success("Re-generating. The transcript is reused, so this is faster.");
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}>
              <Sparkles /> Re-generate {restyle?.clip_count} clips
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<div className="skeleton mx-auto h-40 max-w-7xl rounded-3xl" />}>
      <ProjectView />
    </Suspense>
  );
}
