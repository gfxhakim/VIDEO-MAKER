"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Cpu, KeyRound, Loader2, LogOut, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, fetcher } from "@/lib/api";

type Health = { binaries: Record<string, boolean>; transcribe_backend: string; whisper_model: string; embedded_worker: boolean };

function Panel({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="glass rounded-3xl border p-5 sm:p-6">
      <h2 className="mb-4 flex items-center gap-2 font-semibold"><Icon className="size-4 shrink-0 text-primary" aria-hidden /> {title}</h2>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { data: health, error: healthError } = useSWR<Health>("/api/health", fetcher);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    // reads better narrow: capped and left-aligned, so the heading starts where it does on every other page
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5">
        <Panel icon={ShieldCheck} title="Account">
          {/* the name block never gets narrower than 9rem: on a small phone the button drops to its own line instead of covering the email */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span aria-hidden className="bg-brand grid size-12 shrink-0 place-items-center rounded-full text-lg font-semibold text-white uppercase">{user?.name?.trim().slice(0, 1) || "?"}</span>
            <div className="min-w-0 flex-1 basis-36">
              <div className="font-medium wrap-anywhere">{user?.name}</div>
              <div className="text-sm wrap-anywhere text-muted-foreground">{user?.email}</div>
            </div>
            <Button variant="outline" onClick={signOut} className="shrink-0 max-sm:grow pointer-coarse:h-11"><LogOut /> Sign out</Button>
          </div>
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
              // same shape as the four tiles below
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
                {[0, 1, 2, 3].map((k) => (
                  <div key={k} className="skeleton h-[4.125rem] rounded-xl" />
                ))}
              </div>
            )
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["FFmpeg", health.binaries?.ffmpeg ? "Installed" : "Missing"],
                ["Transcription", health.transcribe_backend === "local" ? "Local Whisper" : "Off"],
                ["Whisper model", health.whisper_model],
                ["Worker", health.embedded_worker ? "Built-in" : "Separate"],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-xl border border-white/10 bg-white/[.03] p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-1 font-medium wrap-anywhere">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-4 text-xs wrap-anywhere text-muted-foreground">Everything runs on this server. No API keys, no third-party services. Change the Whisper model with the WHISPER_MODEL variable (tiny, base, small).</p>
        </Panel>
      </div>
    </div>
  );
}
