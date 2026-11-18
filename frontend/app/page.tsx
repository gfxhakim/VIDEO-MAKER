"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Clapperboard, Film, FileVideo, FolderOpen, Link2, Loader2, Sparkles, Trash2, UploadCloud, Wand2 } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import { StyleSelector } from "@/components/style-selector";
import { UploadProgress, useUpload } from "@/components/upload-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { api, DEFAULT_SETTINGS, fetcher, type Clip, type GenerationSettings, type Project } from "@/lib/api";
import { cn, fmtBytes, fmtDuration } from "@/lib/utils";

const SOURCES = [
  { key: "upload", label: "Upload", short: "Upload", icon: UploadCloud },
  { key: "url", label: "Video link", short: "Link", icon: Link2 },
  { key: "path", label: "Server path", short: "Path", icon: FolderOpen },
] as const;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Stat({ label, value, icon: Icon, delay }: { label: string; value: number | string; icon: React.ElementType; delay: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }} className="glass rounded-2xl border p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">{label}<Icon className="size-4" /></div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </motion.div>
  );
}

export default function Studio() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: projects, mutate } = useSWR<Project[]>("/api/projects", fetcher, {
    refreshInterval: (d) => (d?.some((p) => p.status === "queued" || p.status === "processing") ? 2000 : 20000),
  });
  const { data: clips } = useSWR<Clip[]>("/api/clips", fetcher);
  const [source, setSource] = useState<(typeof SOURCES)[number]["key"]>("upload");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const up = useUpload(); // lives above the pages: the upload keeps going while you pick a style or browse
  const u = up.upload;
  const unfinished = up.unfinished.find((x) => x.received_bytes > 0); // left over from an earlier visit
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_SETTINGS);
  const [styleOpen, setStyleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new")) composer.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const ready = (source === "upload" && !!u && u.phase !== "error") || (source === "url" && /^https?:\/\//.test(url.trim())) || (source === "path" && !!path.trim());

  async function generate() {
    if (source === "upload") {
      if (!u) return;
      up.generate(settings); // starts now if every byte is in, otherwise the moment the upload finishes
      setStyleOpen(false);
      if (u.phase !== "uploaded") toast.success(`${settings.clip_count} clips will start when the upload finishes`, { description: "Keep this tab open. You can use the rest of the app meanwhile." });
      return; // the upload provider opens the project when it exists
    }
    setBusy(true);
    try {
      let p: Project;
      if (source === "url") p = await api.createFromLink({ url: url.trim(), settings });
      else p = await api.createFromLink({ path: path.trim(), settings });
      toast.success("Your clips are cooking", { description: `${settings.clip_count} clips on the way.` });
      setStyleOpen(false);
      mutate();
      router.push(`/project?id=${p.id}`);
    } catch (e) {
      toast.error("Could not start", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const readyClips = clips?.length ?? 0;
  const approved = clips?.filter((c) => c.review_status === "approved").length ?? 0;
  const posted = clips?.filter((c) => Object.keys(c.posted ?? {}).length).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={greeting()}
        title={<>Hey {user?.name ?? "there"}, let&apos;s make something <span className="text-gradient">go viral</span>.</>}
        description="Drop in a long video and get 10 to 50 vertical clips with captions, smart framing and music."
      />

      {/* composer */}
      <motion.div ref={composer} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
        className="glass relative mb-8 overflow-hidden rounded-3xl border p-4 sm:p-6">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_300px]">
          <div>
            <div className="mb-4 flex rounded-xl bg-white/[.04] p-1 sm:w-fit">
              {SOURCES.map(({ key, label, short, icon: Icon }) => (
                <button key={key} onClick={() => setSource(key)} className={cn("relative flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition sm:flex-none sm:px-4", source === key ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {source === key && <motion.span layoutId="src-pill" className="absolute inset-0 rounded-lg bg-white/10 ring-1 ring-white/10" />}
                  <Icon className="relative size-4" /><span className="relative sm:hidden">{short}</span><span className="relative hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={source} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
                {source === "upload" && (
                  <div
                    onClick={() => !u && fileInput.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) up.start(f); }}
                    className={cn("relative grid min-h-44 place-items-center rounded-2xl border-2 border-dashed border-white/15 text-center transition", !u && "cursor-pointer", drag ? "scale-[1.01] border-primary bg-primary/10" : !u && "hover:border-white/30 hover:bg-white/[.02]")}
                  >
                    {u ? (
                      <div className="w-full max-w-lg px-4 py-5 text-left text-sm">
                        <div className="mb-3 flex items-center gap-3">
                          <span className="bg-brand grid size-11 shrink-0 place-items-center rounded-xl"><FileVideo className="size-5 text-white" /></span>
                          <div className="min-w-0"><div className="truncate font-medium">{u.fileName}</div><div className="text-xs text-muted-foreground">{fmtBytes(u.size)}</div></div>
                        </div>
                        <UploadProgress />
                        {u.autoStart && <p className="mt-2 text-xs text-muted-foreground">Clips start by themselves when the upload finishes. Keep this tab open.</p>}
                      </div>
                    ) : unfinished ? (
                      <div className="px-4 text-sm text-muted-foreground">
                        <UploadCloud className="mx-auto mb-3 size-9 text-primary" />
                        <span className="text-foreground">{Math.floor((unfinished.received_bytes / unfinished.size) * 100)}% of &ldquo;{unfinished.filename}&rdquo; is already uploaded</span>
                        <div className="mt-1 text-xs">Choose the same file again to continue from {fmtBytes(unfinished.received_bytes)}.</div>
                        <button onClick={(e) => { e.stopPropagation(); up.discard(unfinished.id); }} className="mt-2 text-xs underline underline-offset-2 hover:text-foreground">Discard it</button>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        <motion.div animate={{ y: drag ? -4 : [0, -4, 0] }} transition={{ repeat: drag ? 0 : Infinity, duration: 2.4 }}>
                          <UploadCloud className="mx-auto mb-3 size-9 text-primary" />
                        </motion.div>
                        <span className="text-foreground">Drop your video here</span> or click to browse
                        <div className="mt-1 text-xs">MP4 · MOV · MKV · WEBM</div>
                      </div>
                    )}
                    <input ref={fileInput} type="file" accept="video/*,.mkv,.avi,.m4v,.flv,.ts" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) up.start(f); e.target.value = ""; }} />
                  </div>
                )}
                {source === "url" && (
                  <div className="flex h-44 flex-col justify-center gap-3">
                    <div className="flex h-14 items-center gap-3 rounded-2xl border border-white/10 bg-white/[.03] px-4 focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/15">
                      <Link2 className="size-5 text-muted-foreground" />
                      <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube, Twitch, Vimeo or X link" className="h-full flex-1 bg-transparent text-sm outline-none" />
                    </div>
                    <p className="text-xs text-muted-foreground">Downloaded at up to 1080p. Only use videos you own or have permission to use.</p>
                  </div>
                )}
                {source === "path" && (
                  <div className="flex h-44 flex-col justify-center gap-3">
                    <div className="flex h-14 items-center gap-3 rounded-2xl border border-white/10 bg-white/[.03] px-4 focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/15">
                      <FolderOpen className="size-5 text-muted-foreground" />
                      <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/data/videos/stream.mp4" className="h-full flex-1 bg-transparent font-mono text-sm outline-none" />
                    </div>
                    <p className="text-xs text-muted-foreground">A file already on the server. Skips the upload for huge recordings.</p>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex flex-col justify-between gap-5 rounded-2xl border border-white/10 bg-black/20 p-5">
            <div>
              <div className="text-sm text-muted-foreground">Clips to generate</div>
              <motion.div key={settings.clip_count} initial={{ scale: 0.9, opacity: 0.5 }} animate={{ scale: 1, opacity: 1 }} className="text-gradient my-1 text-6xl font-bold tabular-nums">
                {settings.clip_count}
              </motion.div>
              <Slider min={10} max={50} step={1} value={[settings.clip_count]} onValueChange={([v]) => setSettings({ ...settings, clip_count: v })} />
              <div className="mt-2 flex gap-1.5">
                {[10, 20, 30, 50].map((n) => (
                  <button key={n} onClick={() => setSettings({ ...settings, clip_count: n })} className={cn("flex-1 rounded-lg border py-1 text-xs transition", settings.clip_count === n ? "border-primary/60 bg-primary/15 text-foreground" : "border-white/10 text-muted-foreground hover:bg-white/5")}>{n}</button>
                ))}
              </div>
            </div>
            <motion.button whileTap={{ scale: 0.97 }} disabled={!ready} onClick={() => setStyleOpen(true)}
              className="bg-brand group flex h-12 items-center justify-center gap-2 rounded-xl font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
              <Wand2 className="size-4" /> {source === "upload" && u?.autoStart ? "Change style" : "Choose style"} <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </motion.button>
          </div>
        </div>
      </motion.div>

      {/* stats */}
      <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Projects" value={projects?.length ?? "–"} icon={Clapperboard} delay={0.1} />
        <Stat label="Clips ready" value={clips ? readyClips : "–"} icon={Film} delay={0.15} />
        <Stat label="Approved" value={clips ? approved : "–"} icon={CheckCircle2} delay={0.2} />
        <Stat label="Posted" value={clips ? posted : "–"} icon={Sparkles} delay={0.25} />
      </div>

      <Dialog open={styleOpen} onOpenChange={(o) => !busy && setStyleOpen(o)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="size-5 text-primary" /> Pick your style</DialogTitle>
            <DialogDescription>Applied to every clip in this run. You can re-style later without transcribing again.</DialogDescription>
          </DialogHeader>
          <DialogBody><StyleSelector value={settings} onChange={setSettings} /></DialogBody>
          <DialogFooter className="flex-col gap-3">
            {source === "upload" && u && <UploadProgress className="sm:mr-auto sm:w-80" />}
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setStyleOpen(false)} disabled={busy}>Back</Button>
              <Button size="lg" onClick={generate} disabled={busy} className="bg-brand flex-1 text-white hover:brightness-110 sm:flex-none">
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate {settings.clip_count} clips
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* projects */}
      <div className="mb-4 flex items-end justify-between">
        <h2 className="text-lg font-semibold">Your projects</h2>
        {!!clips?.length && <Link href="/library" className="text-sm text-primary hover:underline">All clips →</Link>}
      </div>
      {!projects ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-56 rounded-2xl" />)}</div>
      ) : projects.length === 0 ? (
        <div className="glass rounded-3xl border border-dashed p-12 text-center">
          <Clapperboard className="mx-auto mb-3 size-8 text-primary" />
          <div className="font-medium">No projects yet</div>
          <p className="mt-1 text-sm text-muted-foreground">Your first run will show up here.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => {
            const live = p.status === "processing" || p.status === "queued";
            return (
              <motion.div key={p.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.3) }}
                className="group glass relative overflow-hidden rounded-2xl border transition hover:-translate-y-0.5 hover:border-white/20">
                <Link href={`/project?id=${p.id}`} className="block">
                  <div className="relative aspect-video overflow-hidden bg-zinc-900">
                    {p.thumb_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumb_url} alt="" className="h-full w-full scale-110 object-cover opacity-70 blur-sm transition duration-500 group-hover:scale-100 group-hover:opacity-90 group-hover:blur-0" />
                    ) : (
                      <div className={cn("grid h-full place-items-center", live && "skeleton")}><FileVideo className="size-8 text-muted-foreground" /></div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    <div className="absolute top-3 left-3"><StatusBadge status={p.status} /></div>
                    {p.duration ? <div className="absolute top-3 right-3 rounded-md bg-black/60 px-1.5 py-0.5 text-xs">{fmtDuration(p.duration)}</div> : null}
                    <div className="absolute inset-x-3 bottom-3">
                      <div className="truncate font-medium text-white">{p.name}</div>
                      <div className="mt-0.5 text-xs text-white/70">
                        {p.status === "done" ? `${p.ready_count} clips ready` : p.status === "failed" ? "Something went wrong" : p.stage || "Waiting to start"}
                      </div>
                    </div>
                  </div>
                </Link>
                <div className="flex items-center gap-3 px-3 py-2.5">
                  {live ? <Progress value={p.progress * 100} /> : <span className="truncate text-xs text-muted-foreground capitalize">{p.settings.editing_style.replaceAll("_", " ")} · {p.settings.caption_style.replaceAll("_", " ")}</span>}
                  <button
                    className="ml-auto rounded-md p-1.5 text-muted-foreground opacity-100 transition hover:bg-white/5 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                    aria-label="Delete project"
                    onClick={async () => {
                      if (!confirm(`Delete "${p.name}" and all its clips?`)) return;
                      await api.deleteProject(p.id);
                      mutate();
                    }}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
