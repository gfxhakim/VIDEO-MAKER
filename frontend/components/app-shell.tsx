"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Film, LayoutGrid, Loader2, LogOut, Music2, Plus, Settings, Sparkles } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Studio", icon: LayoutGrid },
  { href: "/library", label: "Clips", icon: Film },
  { href: "/music", label: "Music", icon: Music2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="bg-brand grid size-9 place-items-center rounded-xl shadow-lg shadow-fuchsia-500/25">
        <Sparkles className="size-4.5 text-white" />
      </span>
      <span className="text-[17px] font-semibold tracking-tight">
        AutoClip <span className="text-gradient">Studio</span>
      </span>
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  const { user, loading, signOut } = useAuth();
  const bare = path.startsWith("/signin");
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/project") : path.startsWith(href));

  if (bare) return <>{children}<div className="aurora" /></>;
  if (loading || !user)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loader2 className="size-6 animate-spin text-primary" />
        <div className="aurora" />
      </div>
    );

  return (
    <div className="flex min-h-dvh">
      <div className="aurora" />
      {/* desktop sidebar */}
      <aside className="glass sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r px-4 py-6 lg:flex">
        <Link href="/" className="mb-8 px-2"><Logo /></Link>
        <Link
          href="/?new=1"
          className="bg-brand mb-6 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 active:scale-[.98]"
        >
          <Plus className="size-4" /> New project
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={cn("relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground", active(href) && "text-foreground")}>
              {active(href) && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-lg bg-white/[.06] ring-1 ring-white/10" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
              <Icon className="relative size-4" />
              <span className="relative">{label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-3 rounded-xl border bg-background/40 p-3">
          <span className="bg-brand grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white uppercase">{user.name.slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          </div>
          <button onClick={signOut} title="Sign out" className="rounded-md p-1.5 text-muted-foreground transition hover:bg-white/5 hover:text-foreground">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <header className="glass sticky top-0 z-30 flex items-center justify-between border-b px-4 py-3 lg:hidden">
          <Link href="/"><Logo /></Link>
          <Link href="/?new=1" className="bg-brand grid size-9 place-items-center rounded-xl text-white" aria-label="New project"><Plus className="size-4" /></Link>
        </header>
        <main className="min-w-0 flex-1 px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-12">{children}</main>
      </div>

      {/* mobile bottom tab bar */}
      <nav className="glass fixed inset-x-3 bottom-3 z-40 flex justify-around rounded-2xl border px-2 py-1.5 shadow-2xl lg:hidden">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={cn("relative flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] text-muted-foreground", active(href) && "text-foreground")}>
            {active(href) && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-xl bg-white/[.07]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
            <Icon className="relative size-5" />
            <span className="relative">{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-xs font-medium tracking-[.2em] text-primary uppercase">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </motion.div>
  );
}
