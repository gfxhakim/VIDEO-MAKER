"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, RotateCw, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { CaptionPreview } from "@/components/caption-preview";
import { api, type AuthStatus, type CaptionStyle } from "@/lib/api";
import { cn } from "@/lib/utils";

// Static copies of three caption presets, so the showcase works before sign-in.
const SHOWCASE: (CaptionStyle & { bg: string })[] = [
  { key: "hormozi", name: "", description: "", mode: "chunk", font: "Montserrat", weight: 900, size: 92, uppercase: true, primary: "#FFFFFF", highlight: "#FFE500", accent: "#3DFF6E", outline_color: "#000", outline: 7, shadow: 3, glow: 0, bg: "from-violet-600/60 via-fuchsia-700/40 to-zinc-900" },
  { key: "neon", name: "", description: "", mode: "word", font: "DM Serif Display", weight: 400, size: 124, uppercase: false, primary: "#fff", highlight: "#fff", accent: "#39FF14", accent_cycle: ["#FFF14A", "#FF2E63", "#39FF14", "#29E7FF"], outline_color: "#fff", outline: 0, shadow: 0, glow: 18, bg: "from-zinc-800 via-zinc-900 to-black" },
  { key: "pop", name: "", description: "", mode: "word", font: "Anton", weight: 400, size: 104, uppercase: true, primary: "#fff", highlight: "#fff", accent: "#2BFF5B", accent_cycle: ["#2BFF5B", "#C14BFF", "#FF3B3B"], outline_color: "#000", outline: 6, shadow: 0, glow: 0, bg: "from-orange-500/50 via-rose-600/40 to-zinc-900" },
];

/** A phone mock. Everything inside is a percentage of the phone, so it can be any size. */
function Phone({ style, className, delay }: { style: (typeof SHOWCASE)[number]; className?: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: [0, -10, 0] }}
      transition={{ opacity: { delay, duration: 0.6 }, y: { delay, duration: 6, repeat: Infinity, ease: "easeInOut" } }}
      className={cn("absolute aspect-[9/16] overflow-hidden rounded-[17%/9.6%] border border-white/15 bg-black shadow-2xl shadow-black/60", className)}
    >
      <div className={cn("absolute inset-0 bg-gradient-to-b", style.bg)} />
      <div className="absolute inset-x-0 top-[21%] mx-auto aspect-square w-[46%] rounded-full bg-white/15" />
      <div className="absolute inset-x-[14%] top-[42%] h-[30%] rounded-t-full bg-white/10" />
      <div className="@container-[size] absolute inset-x-[3%] top-[57%] h-[30%]">
        <CaptionPreview style={style} frame={600} />
      </div>
      <div className="absolute top-[2.2%] left-1/2 h-[4.4%] w-[34%] -translate-x-1/2 rounded-full bg-black/80" />
    </motion.div>
  );
}

export default function SignInPage() {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [offline, setOffline] = useState(false); // the status call failed
  const [checking, setChecking] = useState(false);
  const [tries, setTries] = useState(0);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api.authStatus();
      setStatus(s);
      setOffline(false);
      if (s.needs_setup) setMode("signup");
    } catch {
      setOffline(true);
      setTries((n) => n + 1);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // A slow or flaky connection: keep asking quietly (a little slower each time) and when the browser is back online.
  useEffect(() => {
    if (!offline) return;
    const t = setTimeout(loadStatus, Math.min(15000, 2500 * tries));
    window.addEventListener("online", loadStatus);
    return () => {
      clearTimeout(t);
      window.removeEventListener("online", loadStatus);
    };
  }, [offline, tries, loadStatus]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") await api.signup(email, password, name);
      else await api.signin(email, password);
      toast.success(mode === "signup" ? "Welcome to AutoClip Studio" : "Welcome back");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setup = status?.needs_setup;
  // The showcase needs a wide and not too flat window; these two class sets must stay opposites.
  return (
    <div className="grid min-h-dvh lg:[@media(min-height:521px)]:grid-cols-[1.1fr_1fr]">
      {/* showcase: exactly one screen tall, so it can never push the page into scrolling */}
      <div className="sticky top-0 hidden h-dvh overflow-hidden border-r border-white/5 lg:[@media(min-height:521px)]:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(139,92,246,.25),transparent_60%)]" />
        <div className="relative z-10 flex h-full flex-col px-10 py-8 xl:px-12 tall:py-12">
          <Logo />
          <div className="mt-7 tall:mt-12">
            <motion.h2
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              // one fluid size instead of stacked breakpoints: follows the window width AND height, so it never crowds the phones
              className="text-[clamp(2.25rem,min(3.4vw,6.4dvh),4.25rem)] leading-[1.15] font-semibold tracking-tight"
            >
              One long video in.<br /><span className="text-gradient">Fifty viral clips</span> out.
            </motion.h2>
            <p className="mt-4 max-w-md text-muted-foreground min-[1800px]:max-w-xl min-[1800px]:text-lg">Auto-detected hooks, face-tracking reframes, kinetic captions and beat-synced music. All rendered on your own server.</p>
          </div>
          {/* The phone stage takes whatever height is left. The fan inside keeps its shape and is as big
              as fits both ways, and the phones are percentages of it, so nothing can overlap the copy or the stats. */}
          <div className="@container-[size] pointer-events-none relative my-6 min-h-0 flex-1 tall:my-10">
            <div className="absolute top-1/2 left-1/2 aspect-[8/5] w-[min(100cqw,160cqh,56rem)] -translate-x-1/2 -translate-y-1/2">
              <Phone style={SHOWCASE[0]} delay={0.1} className="top-[11%] left-[1.5%] h-[84%] rotate-[-7deg]" />
              <Phone style={SHOWCASE[1]} delay={0.3} className="top-[3%] left-1/2 z-10 h-[92%] -translate-x-1/2 rotate-[2deg]" />
              <Phone style={SHOWCASE[2]} delay={0.5} className="top-[12%] right-[1.5%] h-[84%] rotate-[7deg] opacity-90" />
            </div>
          </div>
          <div className="flex gap-8 text-sm text-muted-foreground">
            <div><div className="text-2xl font-semibold text-foreground">9:16</div>ready to post</div>
            <div><div className="text-2xl font-semibold text-foreground">1 to 50</div>clips per run</div>
            <div><div className="text-2xl font-semibold text-foreground">0</div>API keys</div>
          </div>
        </div>
      </div>

      {/* form. On a phone held sideways (short:) it becomes two columns so the button stays on screen. */}
      <div className="flex min-w-0 items-center justify-center px-5 py-10 sm:px-8 short:py-4 tall:py-12">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-sm short:grid short:max-w-3xl short:grid-cols-2 short:gap-x-10"
        >
          <div className="short:col-start-1 short:row-start-1 short:self-end">
            <div className="mb-8 short:mb-5 lg:[@media(min-height:521px)]:hidden"><Logo /></div>
            <AnimatePresence mode="wait">
              <motion.div key={mode} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
                <h1 className="text-3xl font-semibold tracking-tight">
                  {setup ? "Set up your studio" : mode === "signup" ? "Create an account" : "Welcome back"}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {setup ? "You're the first one here. This account becomes the owner." : mode === "signup" ? "Join this AutoClip Studio." : "Sign in to keep clipping."}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4 short:col-start-2 short:row-span-2 short:row-start-1 short:mt-0 short:gap-2.5 short:self-center">
            {mode === "signup" && (
              <Field icon={UserIcon} label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" className="h-full w-full min-w-0 bg-transparent outline-none" />
              </Field>
            )}
            <Field icon={Mail} label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" inputMode="email" autoCapitalize="none" className="h-full w-full min-w-0 bg-transparent outline-none" />
            </Field>
            <Field icon={Lock} label="Password" trailing={
              <button
                type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
                className="-mr-2.5 grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            }>
              <input type={show ? "text" : "password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"} autoComplete={mode === "signup" ? "new-password" : "current-password"} className="h-full w-full min-w-0 bg-transparent outline-none" />
            </Field>

            <AnimatePresence>
              {error && (
                <motion.p role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="rounded-lg bg-destructive/10 px-3 py-2 text-sm wrap-anywhere text-destructive">
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
            {offline && !error && (
              <div role="status" className="flex items-center gap-2 rounded-lg bg-warning/10 py-1 pr-1 pl-3 text-sm text-warning">
                <span className="min-w-0 flex-1">Cannot reach the server. Check your connection.</span>
                <button
                  type="button" onClick={loadStatus} disabled={checking}
                  className="flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium outline-none hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <RotateCw className={cn("size-3.5", checking && "animate-spin")} aria-hidden /> Try again
                </button>
              </div>
            )}

            {/* never locked by the status check: on a bad connection the user can still try, and gets a clear message */}
            <motion.button whileTap={{ scale: 0.98 }} disabled={busy} className="bg-brand group mt-2 flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition outline-none hover:brightness-110 focus-visible:ring-4 focus-visible:ring-primary/40 disabled:opacity-60 short:mt-1">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "signup" ? "Create account" : "Sign in"}
              {!busy && <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />}
            </motion.button>
          </form>

          <div className="short:col-start-1 short:row-start-2 short:self-start">
            {status && !setup && status.signup_open && (
              <p className="mt-6 text-center text-sm text-muted-foreground short:mt-4 short:text-left">
                {mode === "signin" ? "New here? " : "Already have an account? "}
                <button type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }} className="-my-2.5 py-2.5 font-medium text-primary hover:underline">
                  {mode === "signin" ? "Create an account" : "Sign in"}
                </button>
              </p>
            )}
            <p className="mt-10 text-center text-xs text-muted-foreground short:mt-3 short:text-left">Self-hosted. Your videos never leave your server.</p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function Field({ icon: Icon, label, children, trailing }: { icon: React.ElementType; label: string; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground short:mb-1">{label}</span>
      <span className="flex h-12 items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] px-4 text-sm transition focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/15 short:h-11 pointer-coarse:text-base">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {children}
        {trailing}
      </span>
    </label>
  );
}
