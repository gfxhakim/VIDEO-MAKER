"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Activity, Cpu, HardDrive, KeyRound, Loader2, LogOut, RotateCw, Save, Shield, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { api, fetcher, type JobItem, type RuntimeSettings, type StorageOverview, type WatermarkPosition } from "@/lib/api";
import { fmtBytes, fmtDate, pctOf } from "@/lib/utils";

type Health = { binaries: Record<string, boolean>; transcribe_backend: string; whisper_model: string; embedded_worker: boolean; cpus?: number; memory_gb?: number; worker_concurrency?: number };

function Panel({ icon: Icon, title, children, action }: { icon: React.ElementType; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="glass rounded-3xl border p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><Icon className="size-4 shrink-0 text-primary" aria-hidden /> {title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { data: health, error: healthError } = useSWR<Health>("/api/health", fetcher);
  const { data: storage, mutate: mutateStorage } = useSWR<StorageOverview>("/api/system/storage", fetcher);
  const { data: jobs, mutate: mutateJobs } = useSWR<JobItem[]>("/api/jobs?limit=30", fetcher, { refreshInterval: 5000 });
  const { data: runtime, mutate: mutateRuntime } = useSWR<RuntimeSettings>("/api/settings", fetcher);

  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const [wmText, setWmText] = useState("");
  const [wmPos, setWmPos] = useState<WatermarkPosition>("bottom_right");
  const [llmUrl, setLlmUrl] = useState("");
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [llmKey, setLlmKey] = useState("");
  const [savingCfg, setSavingCfg] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);

  useEffect(() => {
    if (!runtime) return;
    setWmText(runtime.default_watermark_text);
    setWmPos(runtime.default_watermark_position);
    setLlmUrl(runtime.llm_base_url);
    setLlmModel(runtime.llm_model);
  }, [runtime]);

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSavingCfg(true);
    try {
      const updated = await api.updateRuntimeSettings({
        default_watermark_text: wmText,
        default_watermark_position: wmPos,
        llm_base_url: llmUrl,
        llm_model: llmModel,
        ...(llmKey ? { llm_api_key: llmKey } : {}),
      });
      await mutateRuntime(updated, { revalidate: false });
      setLlmKey("");
      toast.success("Preferences saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingCfg(false);
    }
  }

  async function testLlm() {
    setTestingLlm(true);
    try {
      await api.testLlm();
      toast.success("AI endpoint responded cleanly");
    } catch (err) {
      toast.error("AI endpoint check failed", { description: (err as Error).message });
    } finally {
      setTestingLlm(false);
    }
  }

  async function pruneProject(pid: number, name: string) {
    if (!window.confirm(`Delete raw source video for "${name}"? Rendered clips stay available.`)) return;
    try {
      const res = await api.pruneSource(pid);
      await mutateStorage();
      toast.success(`Freed ${fmtBytes(res.freed_bytes)}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const diskPct = storage ? pctOf(storage.disk.used, storage.disk.total) : 0;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5">
        <Panel icon={ShieldCheck} title="Account">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span aria-hidden className="bg-brand grid size-12 shrink-0 place-items-center rounded-full text-lg font-semibold text-white uppercase">{user?.name?.trim().slice(0, 1) || "?"}</span>
            <div className="min-w-0 flex-1 basis-36">
              <div className="flex flex-wrap items-center gap-2 font-medium wrap-anywhere">
                <span>{user?.name}</span>
                {user?.role === "admin" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-400/30 bg-fuchsia-500/15 px-2 py-0.5 text-[11px] font-medium text-fuchsia-300">
                    <Shield className="size-3" /> Admin
                  </span>
                )}
              </div>
              <div className="text-sm wrap-anywhere text-muted-foreground">{user?.email}</div>
            </div>
            <div className="flex flex-wrap gap-2 max-sm:w-full">
              {user?.role === "admin" && (
                <Link href="/admin" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/15 px-3.5 text-sm font-medium text-fuchsia-200 transition hover:bg-fuchsia-500/25 max-sm:flex-1 max-sm:justify-center">
                  <Shield className="size-4" /> Admin Panel
                </Link>
              )}
              <Button variant="outline" onClick={signOut} className="shrink-0 max-sm:flex-1 pointer-coarse:h-11"><LogOut /> Sign out</Button>
            </div>
          </div>
        </Panel>

        <Panel icon={Sparkles} title="Brand defaults & Optional AI enhancement">
          <form onSubmit={saveConfig} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">Default watermark handle
                <Input value={wmText} onChange={(e) => setWmText(e.target.value)} placeholder="@yourhandle" className="mt-1.5 text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">Default watermark corner
                <select
                  value={wmPos}
                  onChange={(e) => setWmPos(e.target.value as WatermarkPosition)}
                  className="mt-1.5 h-10 w-full rounded-md border border-input bg-zinc-900 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="top_left">Top left</option>
                  <option value="top_right">Top right</option>
                  <option value="bottom_left">Bottom left</option>
                  <option value="bottom_right">Bottom right</option>
                </select>
              </label>
            </div>

            <div className="border-t border-white/10 pt-4">
              <p className="mb-3 text-xs text-muted-foreground">
                Optional: connect a local Ollama server (<code className="text-foreground">http://localhost:11434/v1</code>) or OpenAI-compatible API to rewrite hooks, titles, and boost moment scoring. Leave blank for 100% local rule-based scoring.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-muted-foreground">Endpoint Base URL
                  <Input value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} placeholder="http://localhost:11434/v1" className="mt-1.5 text-foreground" />
                </label>
                <label className="text-xs text-muted-foreground">Model name
                  <Input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="llama3.2 / gpt-4o-mini" className="mt-1.5 text-foreground" />
                </label>
                <label className="text-xs text-muted-foreground">API Key {runtime?.llm_has_key ? "(saved)" : "(optional)"}
                  <Input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder={runtime?.llm_has_key ? "••••••••" : "Optional for Ollama"} className="mt-1.5 text-foreground" />
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={savingCfg} className="pointer-coarse:h-11">
                {savingCfg ? <Loader2 className="animate-spin" /> : <Save />} Save preferences
              </Button>
              {runtime?.llm_configured && (
                <Button type="button" variant="outline" disabled={testingLlm} onClick={testLlm} className="pointer-coarse:h-11">
                  {testingLlm ? <Loader2 className="animate-spin" /> : <Sparkles />} Test AI connection
                </Button>
              )}
            </div>
          </form>
        </Panel>

        <Panel icon={HardDrive} title="Storage & Cleanup" action={<Button variant="ghost" size="sm" onClick={() => mutateStorage()}><RotateCw className="size-3.5" /> Refresh</Button>}>
          {!storage ? (
            <div className="skeleton h-24 rounded-xl" />
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span>Volume usage</span>
                  <span className="text-muted-foreground tabular-nums">{fmtBytes(storage.disk.used)} used · {fmtBytes(storage.disk.free)} free</span>
                </div>
                <Progress value={diskPct} className="h-2" />
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>Music: {fmtBytes(storage.music_bytes)}</span>
                  <span>B-roll: {fmtBytes(storage.broll_bytes)}</span>
                  <span>Pending uploads: {fmtBytes(storage.uploads_bytes)}</span>
                  <span>AI models: {fmtBytes(storage.models_bytes)}</span>
                </div>
              </div>
              {storage.projects.length > 0 && (
                <div className="divide-y divide-white/10 rounded-xl border border-white/10 bg-black/20">
                  {storage.projects.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">{p.name}</div>
                        <div className="text-muted-foreground tabular-nums">
                          Clips: {fmtBytes(p.clips_bytes)} · Source: {p.source_deleted ? "Deleted" : fmtBytes(p.source_bytes)}
                        </div>
                      </div>
                      {!p.source_deleted && p.source_bytes > 0 && p.status !== "processing" && p.status !== "queued" && (
                        <Button variant="outline" size="sm" onClick={() => pruneProject(p.id, p.name)} className="h-8 text-xs">
                          <Trash2 className="size-3.5" /> Free {fmtBytes(p.source_bytes)}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel icon={Activity} title="Background job queue" action={<Button variant="ghost" size="sm" onClick={() => mutateJobs()}><RotateCw className="size-3.5" /> Refresh</Button>}>
          {!jobs ? (
            <div className="skeleton h-20 rounded-xl" />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jobs recorded yet.</p>
          ) : (
            <div className="max-h-72 divide-y divide-white/10 overflow-y-auto rounded-xl border border-white/10 bg-black/20">
              {jobs.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-foreground">{j.kind}</span>
                  <span className="text-muted-foreground tabular-nums">#{j.id} · {fmtDate(j.created_at)}</span>
                  {j.error && <span className="basis-full truncate font-mono text-[11px] text-destructive" title={j.error}>{j.error}</span>}
                  <div className="ml-auto flex gap-1">
                    {j.status === "failed" && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={async () => { await api.retryJob(j.id); void mutateJobs(); }}>
                        <RotateCw className="size-3" /> Retry
                      </Button>
                    )}
                    {j.status === "queued" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={async () => { await api.cancelJob(j.id); void mutateJobs(); }}>
                        <X className="size-3" /> Cancel
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel icon={KeyRound} title="Change password">
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.changePassword(cur, next);
                toast.success("Password updated");
                setCur("");
                setNext("");
              } catch (err) {
                toast.error((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required className="min-w-0 pointer-coarse:h-11 pointer-coarse:text-base" />
            <Input type="password" aria-label="New password" placeholder="New password (8+ characters)" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required className="min-w-0 pointer-coarse:h-11 pointer-coarse:text-base" />
            <Button disabled={busy} className="pointer-coarse:h-11">{busy && <Loader2 className="animate-spin" />} Update</Button>
          </form>
        </Panel>

        <Panel icon={Cpu} title="Server">
          {!health ? (
            healthError ? (
              <p className="text-sm text-muted-foreground">The server details did not load. Check your connection.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
                {[0, 1, 2, 3].map((k) => <div key={k} className="skeleton h-[4.125rem] rounded-xl" />)}
              </div>
            )
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["FFmpeg", health.binaries?.ffmpeg ? "Installed" : "Missing"],
                ["Transcription", health.transcribe_backend === "local" ? "Local Whisper" : "Off"],
                ["Whisper model", health.whisper_model],
                ["Worker", `${health.embedded_worker ? "Built-in" : "Separate"} (${health.worker_concurrency ?? 1}×)`],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-xl border border-white/10 bg-white/[.03] p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-1 font-medium wrap-anywhere">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-4 text-xs wrap-anywhere text-muted-foreground">Everything runs on this server. Change the Whisper model with the WHISPER_MODEL variable (tiny, base, small).</p>
        </Panel>
      </div>
    </div>
  );
}
