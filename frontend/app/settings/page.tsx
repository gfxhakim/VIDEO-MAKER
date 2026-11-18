"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Cpu, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, fetcher } from "@/lib/api";

type Health = { binaries: Record<string, boolean>; transcribe_backend: string; whisper_model: string; embedded_worker: boolean };

function Panel({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="glass rounded-3xl border p-5 sm:p-6">
      <h2 className="mb-4 flex items-center gap-2 font-semibold"><Icon className="size-4 text-primary" /> {title}</h2>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { data: health } = useSWR<Health>("/api/health", fetcher);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-5">
        <Panel icon={ShieldCheck} title="Account">
          <div className="flex flex-wrap items-center gap-4">
            <span className="bg-brand grid size-12 place-items-center rounded-full text-lg font-semibold text-white uppercase">{user?.name.slice(0, 1)}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{user?.name}</div>
              <div className="text-sm text-muted-foreground">{user?.email}</div>
            </div>
            <Button variant="outline" onClick={signOut}><LogOut /> Sign out</Button>
          </div>
        </Panel>

        <Panel icon={KeyRound} title="Change password">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
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
            <Input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} required />
            <Input type="password" placeholder="New password (8+ characters)" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
            <Button disabled={busy}>Update</Button>
          </form>
        </Panel>

        <Panel icon={Cpu} title="Server">
          {!health ? (
            <div className="skeleton h-16 rounded-xl" />
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["FFmpeg", health.binaries.ffmpeg ? "Installed" : "Missing"],
                ["Transcription", health.transcribe_backend === "local" ? "Local Whisper" : "Off"],
                ["Whisper model", health.whisper_model],
                ["Worker", health.embedded_worker ? "Built-in" : "Separate"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-1 font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Everything runs on this server. No API keys, no third-party services. Change the Whisper model with the WHISPER_MODEL variable (tiny, base, small).</p>
        </Panel>
      </div>
    </div>
  );
}
