"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { toast } from "sonner";
import {
  Activity,
  Ban,
  CheckCircle2,
  Cookie,
  FolderKanban,
  HardDrive,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  fetcher,
  type AdminActivityResponse,
  type AdminJobRow,
  type AdminOverview,
  type AdminProjectRow,
  type AdminSettings,
  type AdminUserRow,
} from "@/lib/api";
import { cn, fmtBytes, fmtDate, pctOf } from "@/lib/utils";

type Tab = "activity" | "users" | "projects" | "jobs";

function relativeTime(iso?: string | null): string {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return sec < 15 ? "just now" : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 14) return `${days}d ago`;
  return fmtDate(iso);
}

function actionColor(action: string): string {
  if (action.startsWith("admin_")) return "border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-300";
  if (action === "signin_failed" || action === "signin_blocked") return "border-rose-500/30 bg-rose-500/15 text-rose-300";
  if (action === "signin" || action === "signup" || action === "signout") return "border-sky-500/30 bg-sky-500/15 text-sky-300";
  if (action.includes("delete") || action.includes("cancel")) return "border-amber-500/30 bg-amber-500/15 text-amber-300";
  if (action.includes("upload") || action.includes("create") || action.includes("generate")) return "border-emerald-500/30 bg-emerald-500/15 text-emerald-300";
  if (action.includes("download") || action.includes("export")) return "border-violet-500/30 bg-violet-500/15 text-violet-300";
  return "border-white/15 bg-white/[.06] text-foreground/90";
}

function StatCard({ label, value, sub, icon: Icon, accent }: { label: string; value: string | number; sub: string; icon: React.ElementType; accent?: string }) {
  return (
    <div className="glass rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className={cn("size-4 shrink-0", accent || "text-primary")} />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "admin";

  const [tab, setTab] = useState<Tab>("activity");
  const [live, setLive] = useState(true);
  const [userSearch, setUserSearch] = useState("");
  const [actUserId, setActUserId] = useState<number | undefined>(undefined);
  const [actAction, setActAction] = useState("");
  const [actQuery, setActQuery] = useState("");
  const [projStatus, setProjStatus] = useState("");

  // Create user modal / inline drawer
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);

  // Password reset prompt state
  const [resettingUser, setResettingUser] = useState<AdminUserRow | null>(null);
  const [resetPass, setResetPass] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  // YouTube / yt-dlp cookies drawer state
  const [showCookies, setShowCookies] = useState(false);
  const [cookiesText, setCookiesText] = useState("");
  const [savingCookies, setSavingCookies] = useState(false);

  const pollMs = live ? 5000 : 0;

  const { data: overview, mutate: mutateOverview } = useSWR<AdminOverview>(isAdmin ? "/api/admin/overview" : null, fetcher, { refreshInterval: pollMs });
  const { data: adminCfg, mutate: mutateAdminCfg } = useSWR<AdminSettings>(isAdmin ? "/api/admin/settings" : null, fetcher);
  const { data: users, mutate: mutateUsers } = useSWR<AdminUserRow[]>(
    isAdmin ? `/api/admin/users${userSearch.trim() ? `?q=${encodeURIComponent(userSearch.trim())}` : ""}` : null,
    fetcher,
    { refreshInterval: pollMs },
  );

  const activityKey = (() => {
    if (!isAdmin) return null;
    const p = new URLSearchParams({ limit: "120" });
    if (actUserId !== undefined) p.set("user_id", String(actUserId));
    if (actAction) p.set("action", actAction);
    if (actQuery.trim()) p.set("q", actQuery.trim());
    return `/api/admin/activity?${p.toString()}`;
  })();
  const { data: activity, mutate: mutateActivity } = useSWR<AdminActivityResponse>(activityKey, fetcher, { refreshInterval: pollMs });

  const { data: allProjects, mutate: mutateProjects } = useSWR<AdminProjectRow[]>(
    isAdmin && tab === "projects"
      ? `/api/admin/projects${projStatus ? `?status=${encodeURIComponent(projStatus)}` : ""}`
      : null,
    fetcher,
    { refreshInterval: pollMs },
  );

  const { data: jobs, mutate: mutateJobs } = useSWR<AdminJobRow[]>(
    isAdmin && tab === "jobs" ? "/api/admin/jobs?limit=60" : null,
    fetcher,
    { refreshInterval: pollMs },
  );

  async function refreshAll() {
    await Promise.all([mutateOverview(), mutateAdminCfg(), mutateUsers(), mutateActivity(), mutateProjects(), mutateJobs()]);
  }

  async function toggleSignup() {
    if (!overview) return;
    const next = !overview.signup_open;
    try {
      await api.adminUpdateSettings({ allow_signup: next });
      await mutateOverview();
      await mutateAdminCfg();
      await mutateActivity();
      toast.success(next ? "Public visitor sign-ups opened" : "Public visitor sign-ups paused");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function saveCookies(e: React.FormEvent) {
    e.preventDefault();
    if (!cookiesText.trim()) return;
    setSavingCookies(true);
    try {
      await api.adminUpdateSettings({ ytdlp_cookies: cookiesText });
      setCookiesText("");
      setShowCookies(false);
      await mutateOverview();
      await mutateAdminCfg();
      await mutateActivity();
      toast.success("YouTube cookies saved for URL downloads");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingCookies(false);
    }
  }

  async function clearCookies() {
    if (!window.confirm("Remove saved YouTube cookies.txt from server?")) return;
    setSavingCookies(true);
    try {
      await api.adminUpdateSettings({ ytdlp_cookies: "" });
      setCookiesText("");
      await mutateOverview();
      await mutateAdminCfg();
      await mutateActivity();
      toast.success("Saved cookies cleared");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingCookies(false);
    }
  }

  async function onCookieFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    setCookiesText(txt);
    e.target.value = "";
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.adminCreateUser({ email: newEmail.trim(), name: newName.trim(), password: newPass, role: newRole });
      setNewEmail("");
      setNewName("");
      setNewPass("");
      setNewRole("user");
      setShowCreate(false);
      await refreshAll();
      toast.success("Account created");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function toggleRole(u: AdminUserRow) {
    const nextRole = u.role === "admin" ? "user" : "admin";
    if (!window.confirm(`Change ${u.email} role to ${nextRole.toUpperCase()}?`)) return;
    setBusyId(u.id);
    try {
      await api.adminUpdateUser(u.id, { role: nextRole });
      await refreshAll();
      toast.success(`${u.email} is now ${nextRole}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(u: AdminUserRow) {
    const next = !u.is_active;
    if (!window.confirm(`${next ? "Reactivate" : "Suspend"} ${u.email}?`)) return;
    setBusyId(u.id);
    try {
      await api.adminUpdateUser(u.id, { is_active: next });
      await refreshAll();
      toast.success(next ? `${u.email} reactivated` : `${u.email} suspended`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function submitResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resettingUser) return;
    setBusyId(resettingUser.id);
    try {
      await api.adminUpdateUser(resettingUser.id, { new_password: resetPass });
      toast.success(`Password updated for ${resettingUser.email}`);
      setResettingUser(null);
      setResetPass("");
      await mutateActivity();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteUser(u: AdminUserRow) {
    if (!window.confirm(`Permanently delete ${u.email} and all ${u.project_count} project(s), clips, and media on disk?`)) return;
    setBusyId(u.id);
    try {
      await api.adminDeleteUser(u.id);
      await refreshAll();
      toast.success(`Deleted ${u.email}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProject(p: AdminProjectRow) {
    if (!window.confirm(`Delete project "${p.name}" (${p.owner?.email ?? "unknown owner"})?`)) return;
    try {
      await api.adminDeleteProject(p.id);
      await refreshAll();
      toast.success(`Deleted "${p.name}"`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function inspectUserActivity(uid: number) {
    setActUserId(uid);
    setTab("activity");
  }

  if (!authLoading && user && !isAdmin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <div className="glass rounded-3xl border p-8">
          <ShieldAlert className="mx-auto size-12 text-amber-400" />
          <h1 className="mt-4 text-2xl font-semibold">Administrator Access Required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account ({user.email}) is a standard creator account. Sign in with an administrator account to inspect users and activity.
          </p>
          <Link href="/" className="bg-brand mt-6 inline-flex h-10 items-center rounded-xl px-5 text-sm font-semibold text-white">
            Back to Studio
          </Link>
        </div>
      </div>
    );
  }

  const diskPct = overview ? pctOf(overview.storage.disk_used, overview.storage.disk_total) : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Admin Control Center"
        description="Monitor live user sessions, every creator action, storage usage, and public visitor registration."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={overview?.ytdlp_cookies_configured ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowCookies((v) => !v)}
              title="Configure Netscape cookies.txt for URL downloads"
            >
              <Cookie className={cn("size-3.5", overview?.ytdlp_cookies_configured ? "text-emerald-400" : "text-amber-400")} />
              YouTube Cookies: {overview?.ytdlp_cookies_configured ? "Ready" : "Not set"}
            </Button>
            <Button
              variant={overview?.signup_open ? "default" : "outline"}
              size="sm"
              onClick={toggleSignup}
              disabled={!overview}
              className={cn(overview?.signup_open ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "")}
            >
              {overview?.signup_open ? <CheckCircle2 className="size-3.5" /> : <Ban className="size-3.5" />}
              Sign-ups: {overview ? (overview.signup_open ? "Open" : "Paused") : "…"}
            </Button>
            <Button
              variant={live ? "secondary" : "outline"}
              size="sm"
              onClick={() => setLive((v) => !v)}
              title="Toggle 5-second live polling"
            >
              <span className={cn("size-2 rounded-full", live ? "animate-pulse bg-emerald-400" : "bg-zinc-500")} />
              {live ? "Live 5s" : "Paused"}
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              <UserPlus className="size-3.5" /> New User
            </Button>
          </div>
        }
      />

      {showCookies && (
        <form onSubmit={saveCookies} className="glass flex flex-col gap-3 rounded-2xl border border-amber-500/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Cookie className="size-4 text-amber-400" /> YouTube &amp; URL Ingestion Cookies (`cookies.txt`)
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Cloud hosts (like Railway) often see YouTube&apos;s sign-in verification gate. Export a signed-in Netscape <code className="text-foreground">cookies.txt</code> file from your browser and upload or paste it here (or set <code className="text-foreground">YTDLP_COOKIES</code> in Railway Variables).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", adminCfg?.ytdlp_cookies_configured ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-white/15 bg-white/5 text-muted-foreground")}>
                {adminCfg?.ytdlp_cookies_configured
                  ? `Active (${adminCfg.ytdlp_cookies_source === "env_file" ? "env file" : "saved"}${adminCfg.ytdlp_cookies_updated_at ? ` · ${relativeTime(adminCfg.ytdlp_cookies_updated_at)}` : ""})`
                  : "Not configured"}
              </span>
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowCookies(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <textarea
            rows={4}
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;... (paste cookies.txt contents or choose a .txt file below)"
            className="w-full rounded-xl border border-input bg-zinc-950/80 p-3 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-white/[.04] px-3 text-xs font-medium hover:bg-white/[.08]">
              <Upload className="size-3.5" /> Choose cookies.txt file
              <input type="file" accept=".txt,text/plain" onChange={onCookieFile} className="sr-only" />
            </label>
            <Button type="submit" size="sm" disabled={savingCookies || !cookiesText.trim()}>
              {savingCookies ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Save cookies
            </Button>
            {adminCfg?.ytdlp_cookies_configured && adminCfg.ytdlp_cookies_source !== "env_file" && (
              <Button type="button" variant="ghost" size="sm" disabled={savingCookies} onClick={clearCookies} className="text-rose-400 hover:bg-rose-500/15 hover:text-rose-300">
                <Trash2 className="size-3.5" /> Remove saved cookies
              </Button>
            )}
          </div>
        </form>
      )}

      {showCreate && (
        <form onSubmit={createUser} className="glass grid gap-3 rounded-2xl border border-fuchsia-500/30 p-4 sm:grid-cols-5">
          <Input type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" />
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" />
          <Input type="password" required minLength={6} value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Password (6+ chars)" />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "user" | "admin")}
            className="h-10 rounded-md border border-input bg-zinc-900 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="user">Standard User</option>
            <option value="admin">Administrator</option>
          </select>
          <div className="flex gap-2">
            <Button type="submit" disabled={creating} className="flex-1">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => setShowCreate(false)}>
              <X className="size-4" />
            </Button>
          </div>
        </form>
      )}

      {resettingUser && (
        <form onSubmit={submitResetPassword} className="glass flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/30 p-4">
          <KeyRound className="size-4 text-amber-400" />
          <span className="text-sm font-medium">Reset password for <span className="text-foreground">{resettingUser.email}</span></span>
          <Input
            type="password"
            required
            minLength={6}
            value={resetPass}
            onChange={(e) => setResetPass(e.target.value)}
            placeholder="New password (6+ chars)"
            className="max-w-xs"
          />
          <Button type="submit" size="sm" disabled={busyId === resettingUser.id}>
            {busyId === resettingUser.id ? <Loader2 className="size-3.5 animate-spin" /> : "Save password"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setResettingUser(null); setResetPass(""); }}>
            Cancel
          </Button>
        </form>
      )}

      {/* KPI overview */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Users"
          value={overview ? overview.users.total : "—"}
          sub={overview ? `${overview.users.online_now} online now · ${overview.users.admins} admin · ${overview.users.suspended} suspended` : "Loading…"}
          icon={Users}
          accent="text-sky-400"
        />
        <StatCard
          label="User Activity (24h)"
          value={overview ? overview.activity_24h : "—"}
          sub={activity ? `${activity.total} matching log events` : "Loading…"}
          icon={Activity}
          accent="text-emerald-400"
        />
        <StatCard
          label="Projects & Clips"
          value={overview ? `${overview.projects.total} / ${overview.clips.ready}` : "—"}
          sub={overview ? `${overview.projects.processing} processing · ${overview.projects.queued} queued · ${overview.clips.approved} approved` : "Loading…"}
          icon={FolderKanban}
          accent="text-fuchsia-400"
        />
        <StatCard
          label="Server Storage & Queue"
          value={overview ? fmtBytes(overview.storage.data_dir_bytes) : "—"}
          sub={overview ? `${diskPct}% disk used (${fmtBytes(overview.storage.disk_free)} free) · ${overview.jobs.running} running` : "Loading…"}
          icon={HardDrive}
          accent="text-amber-400"
        />
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
        {(
          [
            { id: "activity", label: "Live Activity", icon: Activity, count: activity?.total },
            { id: "users", label: "Users & Activity Summary", icon: Users, count: users?.length },
            { id: "projects", label: "All Projects", icon: FolderKanban, count: overview?.projects.total },
            { id: "jobs", label: "Worker Queue", icon: Server, count: overview ? overview.jobs.queued + overview.jobs.running : undefined },
          ] as const
        ).map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition",
              tab === id ? "bg-brand text-white shadow-sm shadow-fuchsia-500/20" : "bg-white/[.04] text-muted-foreground hover:bg-white/[.08] hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
            {count !== undefined && (
              <span className={cn("rounded-full px-1.5 py-0.5 text-[11px]", tab === id ? "bg-white/20 text-white" : "bg-white/10 text-muted-foreground")}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* TAB 1: LIVE ACTIVITY STREAM */}
      {tab === "activity" && (
        <section className="glass rounded-3xl border p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={actQuery}
                onChange={(e) => setActQuery(e.target.value)}
                placeholder="Search user email, action detail, IP address…"
                className="pl-9"
              />
            </div>
            <select
              value={actUserId ?? ""}
              onChange={(e) => setActUserId(e.target.value ? Number(e.target.value) : undefined)}
              className="h-10 rounded-md border border-input bg-zinc-900 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All users</option>
              {users?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
            <select
              value={actAction}
              onChange={(e) => setActAction(e.target.value)}
              className="h-10 rounded-md border border-input bg-zinc-900 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All actions</option>
              {activity?.actions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            {(actUserId !== undefined || actAction || actQuery) && (
              <Button variant="ghost" size="sm" onClick={() => { setActUserId(undefined); setActAction(""); setActQuery(""); }}>
                <X className="size-3.5" /> Clear
              </Button>
            )}
          </div>

          {!activity ? (
            <div className="skeleton h-48 rounded-2xl" />
          ) : activity.items.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No matching activity logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Action</th>
                    <th className="py-2 pr-3 font-medium">What they did</th>
                    <th className="py-2 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {activity.items.map((ev) => (
                    <tr key={ev.id} className="hover:bg-white/[.02]">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-xs text-muted-foreground" title={fmtDate(ev.created_at)}>
                        {relativeTime(ev.created_at)}
                      </td>
                      <td className="py-2.5 pr-3">
                        {ev.user_id ? (
                          <button
                            type="button"
                            onClick={() => setActUserId(ev.user_id ?? undefined)}
                            className="text-left hover:underline"
                          >
                            <div className="font-medium text-foreground">{ev.user_name}</div>
                            <div className="text-xs text-muted-foreground">{ev.user_email}</div>
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{ev.user_email || "Visitor"}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <span className={cn("inline-flex rounded-md border px-2 py-0.5 font-mono text-[11px]", actionColor(ev.action))}>
                          {ev.action}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-sm text-foreground/90">{ev.detail || "—"}</td>
                      <td className="py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground" title={ev.user_agent}>
                        {ev.ip || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* TAB 2: USERS */}
      {tab === "users" && (
        <section className="glass rounded-3xl border p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Filter by name or email…"
                className="pl-9"
              />
            </div>
          </div>

          {!users ? (
            <div className="skeleton h-48 rounded-2xl" />
          ) : users.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No users match this filter.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {users.map((u) => (
                <div key={u.id} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[.02] p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="relative shrink-0">
                      <span className="bg-brand grid size-10 place-items-center rounded-full text-sm font-semibold text-white uppercase">
                        {u.name.slice(0, 1) || "?"}
                      </span>
                      <span
                        title={u.online ? "Online now" : "Offline"}
                        className={cn(
                          "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-zinc-950",
                          !u.is_active ? "bg-rose-500" : u.online ? "bg-emerald-400" : "bg-zinc-600",
                        )}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium wrap-anywhere">{u.name}</span>
                        <span className="text-xs wrap-anywhere text-muted-foreground">{u.email}</span>
                        {u.role === "admin" && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/15 px-2 py-0.5 text-[11px] font-medium text-fuchsia-300">
                            <ShieldCheck className="size-3" /> Admin
                          </span>
                        )}
                        {!u.is_active && (
                          <span className="rounded-full border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-300">
                            Suspended
                          </span>
                        )}
                        {u.online && u.is_active && (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                            Online now
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Seen: {relativeTime(u.last_seen_at)}</span>
                        <span>Login: {relativeTime(u.last_login_at)}</span>
                        {u.last_ip && <span className="font-mono">IP {u.last_ip}</span>}
                        <span>{u.project_count} projects · {u.clip_count} clips · {fmtBytes(u.storage_bytes)}</span>
                        <span>{u.activity_count} events</span>
                      </div>
                      {u.last_action && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                          <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", actionColor(u.last_action.action))}>
                            {u.last_action.action}
                          </span>
                          <span className="text-foreground/85">{u.last_action.detail}</span>
                          <span className="text-muted-foreground">({relativeTime(u.last_action.created_at)})</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => inspectUserActivity(u.id)}>
                      <Activity className="size-3.5" /> Activity
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setResettingUser(u); setResetPass(""); }}>
                      <KeyRound className="size-3.5" /> Password
                    </Button>
                    {u.id !== user?.id && (
                      <>
                        <Button variant="outline" size="sm" disabled={busyId === u.id} onClick={() => toggleRole(u)}>
                          <Shield className="size-3.5" /> {u.role === "admin" ? "Demote" : "Make Admin"}
                        </Button>
                        <Button variant="outline" size="sm" disabled={busyId === u.id} onClick={() => toggleActive(u)}>
                          {u.is_active ? <Ban className="size-3.5 text-amber-400" /> : <UserCheck className="size-3.5 text-emerald-400" />}
                          {u.is_active ? "Suspend" : "Activate"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === u.id}
                          onClick={() => deleteUser(u)}
                          className="text-rose-400 hover:bg-rose-500/15 hover:text-rose-300"
                        >
                          <Trash2 className="size-3.5" /> Delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 3: ALL PROJECTS */}
      {tab === "projects" && (
        <section className="glass rounded-3xl border p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select
              value={projStatus}
              onChange={(e) => setProjStatus(e.target.value)}
              className="h-9 rounded-md border border-input bg-zinc-900 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All statuses</option>
              <option value="processing">Processing</option>
              <option value="queued">Queued</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          {!allProjects ? (
            <div className="skeleton h-40 rounded-2xl" />
          ) : allProjects.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No projects found.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {allProjects.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[.02] px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium wrap-anywhere">{p.name}</span>
                      <StatusBadge status={p.status} />
                      <span className="text-xs text-muted-foreground">by {p.owner ? `${p.owner.name} (${p.owner.email})` : "Legacy / shared"}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {p.source_type.toUpperCase()} · {p.ready_count}/{p.clip_count} clips ready · {fmtBytes(p.storage_bytes)} · {p.stage || fmtDate(p.created_at)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteProject(p)}
                    className="text-rose-400 hover:bg-rose-500/15 hover:text-rose-300"
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: WORKER QUEUE */}
      {tab === "jobs" && (
        <section className="glass rounded-3xl border p-4 sm:p-5">
          {!jobs ? (
            <div className="skeleton h-40 rounded-2xl" />
          ) : jobs.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Queue is idle with no recent jobs.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {jobs.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[.02] px-3.5 py-2.5 text-sm">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-xs">{j.kind}</span>
                  <span className="text-xs text-muted-foreground">
                    {j.project_name ? `"${j.project_name}"` : j.project_id ? `Project #${j.project_id}` : ""}
                    {j.owner_email ? ` · ${j.owner_email}` : ""}
                  </span>
                  {j.error && <span className="min-w-0 flex-1 truncate text-xs text-rose-400" title={j.error}>{j.error}</span>}
                  <span className="ml-auto text-xs text-muted-foreground">{relativeTime(j.created_at)}</span>
                  {(j.status === "failed" || j.status === "cancelled") && (
                    <Button variant="outline" size="sm" onClick={async () => { await api.retryJob(j.id); await refreshAll(); }}>
                      <RefreshCw className="size-3.5" /> Retry
                    </Button>
                  )}
                  {j.status === "queued" && (
                    <Button variant="ghost" size="sm" onClick={async () => { await api.cancelJob(j.id); await refreshAll(); }}>
                      <X className="size-3.5" /> Cancel
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
