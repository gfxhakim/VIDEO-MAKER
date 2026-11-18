"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { FileVideo, FolderOpen, Link2, Loader2, Sparkles, Trash2, UploadCloud, Wand2 } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { StyleSelector } from "@/components/style-selector";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, DEFAULT_SETTINGS, fetcher, type GenerationSettings, type Project } from "@/lib/api";
import { cn, fmtDuration } from "@/lib/utils";

export default function Dashboard() {
  const router = useRouter();
  const { data: projects, mutate } = useSWR<Project[]>("/api/projects", fetcher, {
    refreshInterval: (d) => (d?.some((p) => p.status === "queued" || p.status === "processing") ? 2000 : 15000),
  });
  const [tab, setTab] = useState("upload");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS);
  const [styleOpen, setStyleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const sourceReady = (tab === "upload" && file) || (tab === "url" && /^https?:\/\//.test(url.trim())) || (tab === "path" && path.trim());

  async function generate() {
    setBusy(true);
    try {
      let p: Project;
      if (tab === "upload" && file) {
        setUploadPct(0);
        p = await api.createFromUpload(file, settings, setUploadPct);
      } else if (tab === "url") {
        p = await api.createFromLink({ url: url.trim(), settings });
      } else {
        p = await api.createFromLink({ path: path.trim(), settings });
      }
      toast.success("Generation started", { description: `${settings.clip_count} clips are on the way.` });
      setStyleOpen(false);
      mutate();
      router.push(`/projects/${p.id}`);
    } catch (e) {
      toast.error("Could not start", { description: (e as Error).message });
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Create viral clips" description="Drop in a long video, pick a style, get 10 to 50 vertical clips with captions and music." />

      <Card className="mb-10 overflow-hidden border-primary/20">
        <CardContent className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="upload"><UploadCloud /> Upload</TabsTrigger>
              <TabsTrigger value="url"><Link2 /> URL</TabsTrigger>
              <TabsTrigger value="path"><FolderOpen /> Local path</TabsTrigger>
            </TabsList>
            <TabsContent value="upload">
              <div
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
                className={cn("grid h-40 cursor-pointer place-items-center rounded-lg border-2 border-dashed text-center transition-colors hover:border-primary/60", drag && "border-primary bg-primary/5")}
              >
                {file ? (
                  <div className="flex items-center gap-3 text-sm"><FileVideo className="size-6 text-primary" /> {file.name} <span className="text-muted-foreground">{(file.size / 1e6).toFixed(0)} MB</span></div>
                ) : (
                  <div className="text-sm text-muted-foreground"><UploadCloud className="mx-auto mb-2 size-7" />Drag a video here or click to browse<div className="text-xs">MP4, MOV, MKV, WEBM</div></div>
                )}
                <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
            </TabsContent>
            <TabsContent value="url">
              <div className="flex h-40 flex-col justify-center gap-2">
                <Input placeholder="https://www.youtube.com/watch?v=…  (YouTube, Twitch VODs, Vimeo, X, TikTok…)" value={url} onChange={(e) => setUrl(e.target.value)} className="h-11" />
                <p className="text-xs text-muted-foreground">Downloaded with yt-dlp at up to 1080p. Only use content you own or have the rights to.</p>
              </div>
            </TabsContent>
            <TabsContent value="path">
              <div className="flex h-40 flex-col justify-center gap-2">
                <Input placeholder="/Users/me/Videos/stream-2024-10-01.mp4" value={path} onChange={(e) => setPath(e.target.value)} className="h-11 font-mono text-sm" />
                <p className="text-xs text-muted-foreground">A file on the machine running the backend. No upload needed, great for huge files.</p>
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex flex-col justify-between gap-5 rounded-lg border bg-background/40 p-4">
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-sm font-medium">Clips per run</span>
                <span className="text-3xl font-semibold tabular-nums text-primary">{settings.clip_count}</span>
              </div>
              <Slider min={10} max={50} step={1} value={[settings.clip_count]} onValueChange={([v]) => setSettings({ ...settings, clip_count: v })} />
              <div className="flex justify-between text-[11px] text-muted-foreground"><span>10</span><span>50</span></div>
            </div>
            <Button size="lg" disabled={!sourceReady} onClick={() => setStyleOpen(true)}>
              <Wand2 /> Choose style & generate
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={styleOpen} onOpenChange={(o) => !busy && setStyleOpen(o)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="size-5 text-primary" /> Style & template</DialogTitle>
            <DialogDescription>These choices shape every clip in this run. You can re-generate later with a different style without re-transcribing.</DialogDescription>
          </DialogHeader>
          <StyleSelector value={settings} onChange={setSettings} />
          <DialogFooter className="sticky -bottom-6 -mx-6 -mb-6 items-center border-t bg-card px-6 py-4">
            {uploadPct !== null && <div className="mr-auto flex w-56 items-center gap-2 text-xs text-muted-foreground"><Progress value={uploadPct} /> {Math.round(uploadPct)}%</div>}
            <Button variant="ghost" onClick={() => setStyleOpen(false)} disabled={busy}>Back</Button>
            <Button size="lg" onClick={generate} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate {settings.clip_count} clips
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <h2 className="mb-4 text-lg font-semibold">Projects</h2>
      {!projects ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No projects yet. Your first run shows up here.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} className="group gap-3 py-0 transition-colors hover:border-primary/40">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="relative aspect-video overflow-hidden rounded-t-xl bg-muted">
                  {p.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumb_url} alt="" className="h-full w-full object-cover opacity-80 blur-[1px] transition group-hover:opacity-100" />
                  ) : (
                    <div className="grid h-full place-items-center text-muted-foreground"><FileVideo className="size-8" /></div>
                  )}
                  <div className="absolute top-2 left-2"><StatusBadge status={p.status} /></div>
                  {p.duration ? <div className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 text-xs">{fmtDuration(p.duration)}</div> : null}
                </div>
              </Link>
              <CardHeader className="px-4">
                <CardTitle className="truncate text-sm"><Link href={`/projects/${p.id}`}>{p.name}</Link></CardTitle>
                <CardDescription className="text-xs">
                  {p.status === "done" ? `${p.ready_count} clips ready` : p.status === "failed" ? <span className="text-destructive">{p.error?.slice(0, 90)}</span> : p.stage || "Waiting"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-3 px-4 pb-4">
                {(p.status === "processing" || p.status === "queued") && <Progress value={p.progress * 100} />}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7 text-muted-foreground opacity-0 group-hover:opacity-100"
                  onClick={async () => {
                    if (!confirm(`Delete "${p.name}" and all its clips?`)) return;
                    await api.deleteProject(p.id);
                    mutate();
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
