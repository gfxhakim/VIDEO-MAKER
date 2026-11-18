"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, User as UserIcon } from "lucide-react";
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

function Phone({ style, className, delay }: { style: (typeof SHOWCASE)[number]; className?: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: [0, -10, 0] }}
      transition={{ opacity: { delay, duration: 0.6 }, y: { delay, duration: 6, repeat: Infinity, ease: "easeInOut" } }}
      className={cn("absolute aspect-[9/16] w-44 overflow-hidden rounded-[28px] border border-white/15 bg-black shadow-2xl shadow-black/60 xl:w-52", className)}
    >
      <div className={cn("absolute inset-0 bg-gradient-to-b", style.bg)} />
      <div className="absolute inset-x-0 top-[22%] mx-auto size-20 rounded-full bg-white/15 blur-[1px]" />
      <div className="absolute inset-x-6 top-[42%] h-24 rounded-t-full bg-white/10" />
      <div className="absolute inset-x-0 top-[62%] grid place-items-center px-2">
        <CaptionPreview style={style} scale={0.3} />
      </div>
      <div className="absolute top-2 left-1/2 h-4 w-14 -translate-x-1/2 rounded-full bg-black/80" />
    </motion.div>
  );
}

export default function SignInPage() {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.authStatus().then((s) => {
      setStatus(s);
      if (s.needs_setup) setMode("signup");
    }).catch(() => setError("Can't reach the server. Is the backend running?"));
  }, []);

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
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* showcase */}
      <div className="relative hidden overflow-hidden border-r border-white/5 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(139,92,246,.25),transparent_60%)]" />
        <div className="relative z-10 flex h-full flex-col p-12">
          <Logo />
          <div className="mt-12 max-w-md">
            <motion.h2 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-4xl leading-tight font-semibold tracking-tight xl:text-5xl">
              One long video in.<br /><span className="text-gradient">Fifty viral clips</span> out.
            </motion.h2>
            <p className="mt-4 text-muted-foreground">Auto-detected hooks, face-tracking reframes, kinetic captions and beat-synced music. All rendered on your own server.</p>
          </div>
          {/* phone stage sits between the copy and the stats so nothing overlaps */}
          <div className="pointer-events-none relative my-8 min-h-[22rem] flex-1">
            <Phone style={SHOWCASE[0]} delay={0.1} className="top-[12%] left-[6%] w-36 rotate-[-8deg] xl:w-40" />
            <Phone style={SHOWCASE[1]} delay={0.3} className="top-0 left-1/2 z-10 w-36 -translate-x-1/2 rotate-[3deg] xl:w-40" />
            <Phone style={SHOWCASE[2]} delay={0.5} className="top-[16%] right-[6%] w-36 rotate-[9deg] opacity-90 xl:w-40" />
          </div>
          <div className="flex gap-8 text-sm text-muted-foreground">
            <div><div className="text-2xl font-semibold text-foreground">9:16</div>ready to post</div>
            <div><div className="text-2xl font-semibold text-foreground">10–50</div>clips per run</div>
            <div><div className="text-2xl font-semibold text-foreground">0</div>API keys</div>
          </div>
        </div>
      </div>

      {/* form */}
      <div className="flex items-center justify-center px-5 py-12">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
          <div className="mb-10 lg:hidden"><Logo /></div>
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

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
            {mode === "signup" && (
              <Field icon={UserIcon} label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" className="h-full w-full bg-transparent outline-none" />
              </Field>
            )}
            <Field icon={Mail} label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" className="h-full w-full bg-transparent outline-none" />
            </Field>
            <Field icon={Lock} label="Password" trailing={
              <button type="button" onClick={() => setShow(!show)} className="text-muted-foreground hover:text-foreground" aria-label="Show password">
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            }>
              <input type={show ? "text" : "password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"} autoComplete={mode === "signup" ? "new-password" : "current-password"} className="h-full w-full bg-transparent outline-none" />
            </Field>

            <AnimatePresence>
              {error && (
                <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.button whileTap={{ scale: 0.98 }} disabled={busy || !status} className="bg-brand group mt-2 flex h-12 items-center justify-center gap-2 rounded-xl font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "signup" ? "Create account" : "Sign in"}
              {!busy && <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />}
            </motion.button>
          </form>

          {status && !setup && status.signup_open && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "signin" ? "New here? " : "Already have an account? "}
              <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }} className="font-medium text-primary hover:underline">
                {mode === "signin" ? "Create an account" : "Sign in"}
              </button>
            </p>
          )}
          <p className="mt-10 text-center text-xs text-muted-foreground">Self-hosted. Your videos never leave your server.</p>
        </motion.div>
      </div>
    </div>
  );
}

function Field({ icon: Icon, label, children, trailing }: { icon: React.ElementType; label: string; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="flex h-12 items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] px-4 text-sm transition focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/15">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {children}
        {trailing}
      </span>
    </label>
  );
}
