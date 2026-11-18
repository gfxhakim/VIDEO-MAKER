"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, Clapperboard, LayoutDashboard, ListChecks, Music2, Scissors, Send } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/review", label: "Review clips", icon: ListChecks },
  { href: "/music", label: "Music library", icon: Music2 },
  { href: "/publish", label: "Publish Hub", icon: Send },
  { href: "/publish/queue", label: "Schedule queue", icon: CalendarClock },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/projects") : path === href);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/40 px-3 py-5 md:flex">
        <Link href="/" className="mb-8 flex items-center gap-2 px-2">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-fuchsia-500 text-primary-foreground">
            <Scissors className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight">AutoClip Studio</span>
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active(href) && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto rounded-lg border bg-background/50 p-3 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
            <Clapperboard className="size-3.5" /> Self-hosted
          </div>
          Videos are processed on your own machine. Nothing leaves it until you publish.
        </div>
      </aside>
      {/* mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 overflow-x-auto border-b bg-background/80 px-4 py-2 backdrop-blur md:hidden">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs", active(href) ? "bg-accent" : "text-muted-foreground")}>
              <Icon className="size-3.5" /> {label}
            </Link>
          ))}
        </header>
        <main className="bg-grid min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
