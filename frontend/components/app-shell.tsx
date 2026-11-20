"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Film, LayoutGrid, LogOut, Music2, Plus, Settings, Shield, Sparkles } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { cn } from "@/lib/utils";

const BASE_NAV = [
  { href: "/", label: "Studio", icon: LayoutGrid },
  { href: "/library", label: "Clips", icon: Film },
  { href: "/music", label: "Music", icon: Music2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

const ADMIN_ITEM = { href: "/admin", label: "Admin", icon: Shield };

const PILL = { type: "spring", stiffness: 500, damping: 40 } as const;

/** `textClassName` styles the word mark only (the sidebar hides it while it is an icon rail). */
export function Logo({ className, textClassName }: { className?: string; textClassName?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="bg-brand grid size-9 shrink-0 place-items-center rounded-xl shadow-lg shadow-fuchsia-500/25">
        <Sparkles className="size-4.5 text-white" />
      </span>
      <span className={cn("text-[1.0625rem] font-semibold tracking-tight whitespace-nowrap", textClassName)}>
        AutoClip <span className="text-gradient">Studio</span>
      </span>
    </span>
  );
}

/** Shown inside the page container while we do not know yet who is here. Never holds any data. */
function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <div className="skeleton h-8 w-56 max-w-[70%] rounded-lg sm:h-9" />
      <div className="skeleton mt-3 h-4 w-80 max-w-full rounded opacity-70" />
      <div className="skeleton mt-6 h-40 rounded-3xl opacity-60 sm:mt-8 sm:h-52 short:h-28" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-24 rounded-2xl opacity-40 sm:h-32" />
        ))}
      </div>
    </div>
  );
}

/**
 * The frame around every signed-in page.
 *
 *   phones and tablets   sticky top bar + floating tab bar
 *   phone held sideways  (`short:`) a slim icon rail on the left instead of both bars, so the page keeps its height
 *   lg (1024px)          the same icon rail, with the account at the bottom
 *   xl (1280px) and up   the full sidebar
 *
 * `<main>` is THE page container: centred, at most 1600px wide, side padding 16 / 24 / 40px and a
 * bottom padding that always clears the tab bar (and the upload dock). Pages render straight into it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  const { user, signOut } = useAuth();
  const bare = path.startsWith("/signin");
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/project") : path.startsWith(href));

  if (bare) return <>{children}<div className="aurora" /></>;

  const initial = user ? user.name?.trim().slice(0, 1) || user.email?.slice(0, 1) || "?" : "";
  const nav = user?.role === "admin" ? [...BASE_NAV, ADMIN_ITEM] : BASE_NAV;

  return (
    <div className="flex min-h-dvh">
      <div className="aurora" />

      {/* sidebar: an icon rail by default, the full sidebar from xl */}
      <aside className="glass-chrome no-scrollbar sticky top-0 z-30 hidden h-dvh w-[4.5rem] shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto border-r px-2 py-5 lg:flex xl:w-64 xl:items-stretch xl:px-4 xl:py-6 short:flex short:py-3 max-lg:short:w-[calc(4rem+env(safe-area-inset-left))] max-lg:short:pl-[calc(0.5rem+env(safe-area-inset-left))]">
        <Link href="/" aria-label="AutoClip Studio, home" className="mb-6 shrink-0 rounded-xl xl:mb-8 xl:px-2 short:mb-3 max-lg:short:hidden">
          <Logo textClassName="hidden xl:inline" />
        </Link>
        <Link
          href="/?new=1"
          aria-label="New project"
          title="New project"
          className="bg-brand mb-4 flex size-11 shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 active:scale-[.97] xl:mb-6 xl:h-auto xl:w-auto xl:px-4 xl:py-2.5 short:mb-2 xl:short:mb-3"
        >
          <Plus className="size-5 xl:size-4" /> <span className="hidden xl:inline">New project</span>
        </Link>
        <nav aria-label="Main" className="flex w-full flex-col gap-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[0.6875rem] leading-none text-muted-foreground transition-colors hover:text-foreground xl:flex-row xl:gap-3 xl:rounded-lg xl:px-3 xl:py-2.5 xl:text-sm xl:leading-5",
                active(href) && "text-foreground",
              )}
            >
              {active(href) && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-[inherit] bg-white/[.06] ring-1 ring-white/10" transition={PILL} />}
              <Icon className="relative size-5 xl:size-4" />
              <span className="relative">{label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex w-full shrink-0 flex-col items-center gap-1.5 pt-4 xl:flex-row xl:gap-3 xl:rounded-xl xl:border xl:bg-background/40 xl:p-3 max-lg:short:hidden">
          {user ? (
            <>
              <span title={`${user.name} (${user.email})`} className="bg-brand grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white uppercase">{initial}</span>
              <div className="hidden min-w-0 flex-1 xl:block">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{user.name}</span>
                  {user.role === "admin" && (
                    <span className="shrink-0 rounded bg-fuchsia-500/20 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-300">Admin</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{user.email}</div>
              </div>
              <button type="button" onClick={signOut} title="Sign out" aria-label="Sign out" className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-white/5 hover:text-foreground">
                <LogOut className="size-4" />
              </button>
            </>
          ) : (
            <>
              <span className="skeleton size-9 shrink-0 rounded-full" />
              <div className="hidden min-w-0 flex-1 xl:block">
                <div className="skeleton h-3.5 w-24 rounded" />
                <div className="skeleton mt-1.5 h-3 w-32 max-w-full rounded opacity-70" />
              </div>
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* phone and tablet top bar */}
        <header className="glass-chrome sticky top-0 z-30 flex items-center justify-between gap-3 border-b pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-2 pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] lg:hidden short:hidden">
          <Link href="/" aria-label="AutoClip Studio, home" className="min-w-0 rounded-xl"><Logo /></Link>
          <Link href="/?new=1" aria-label="New project" className="bg-brand grid size-11 shrink-0 place-items-center rounded-xl text-white shadow-lg shadow-fuchsia-500/20 transition active:scale-95">
            <Plus className="size-5" />
          </Link>
        </header>
        <main className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 pt-5 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(6.5rem+env(safe-area-inset-bottom)+var(--upload-dock-h,0px))] pl-[max(1rem,env(safe-area-inset-left))] sm:pt-6 sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] lg:px-10 lg:pt-10 lg:pb-[calc(3rem+var(--upload-dock-h,0px))] short:pt-4 short:pb-[calc(1.5rem+env(safe-area-inset-bottom)+var(--upload-dock-h,0px))] max-lg:short:pl-5">
          {user ? children : <PageSkeleton />}
        </main>
      </div>

      {/* phone and tablet tab bar: floats, never wider than a phone, clear of the home indicator */}
      <nav aria-label="Main" className="glass-chrome fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md justify-around rounded-2xl border p-1.5 shadow-2xl shadow-black/50 lg:hidden short:hidden">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={active(href) ? "page" : undefined}
            className={cn("relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[0.6875rem] text-muted-foreground", active(href) && "text-foreground")}
          >
            {active(href) && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-xl bg-white/[.08]" transition={PILL} />}
            <Icon className="relative size-5" />
            <span className="relative">{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The heading block of a page. A long name (project names are file names, often one unbroken
 * word) wraps anywhere and is cut after a few lines, so it can never widen the page or run under
 * the actions. From `sm` the actions sit on the right and drop below the title when there is no
 * room; on phones they are a row of equal-width buttons under it.
 */
export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="mb-5 flex min-w-0 flex-col gap-3 sm:mb-8 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-x-6 sm:gap-y-4 short:mb-4"
    >
      <div className="min-w-0 flex-1 sm:basis-80">
        {eyebrow && <div className="mb-1.5 text-xs font-medium tracking-[.2em] text-primary uppercase sm:mb-2">{eyebrow}</div>}
        <h1 title={typeof title === "string" ? title : undefined} className="line-clamp-3 text-2xl font-semibold tracking-tight text-balance wrap-anywhere sm:line-clamp-2 sm:text-3xl">
          {title}
        </h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-pretty wrap-anywhere text-muted-foreground sm:mt-2">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 max-sm:*:flex-1">{actions}</div>}
    </motion.div>
  );
}
