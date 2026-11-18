"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { ExternalLink, FlaskConical, Plug, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PLATFORM_LABEL, PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, fetcher, type Account, type Platform, type PlatformsInfo } from "@/lib/api";

function OAuthToasts() {
  const q = useSearchParams();
  useEffect(() => {
    const c = q.get("connected");
    const e = q.get("error");
    if (c) toast.success(`Connected ${c} account${c === "1" ? "" : "s"}`);
    if (e) toast.error("Connection failed", { description: e });
  }, [q]);
  return null;
}

function AccountRow({ a, onChange }: { a: Account; onChange: () => void }) {
  const [limit, setLimit] = useState(a.daily_limit);
  const [gap, setGap] = useState(a.min_interval_minutes);
  const save = async (body: Parameters<typeof api.updateAccount>[1]) => {
    try {
      await api.updateAccount(a.id, body);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/40 px-3 py-2">
      {a.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.avatar_url} alt="" className="size-8 rounded-full" />
      ) : (
        <PlatformIcon platform={a.platform} className="size-8" />
      )}
      <div className="min-w-36 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">{a.display_name} <PlatformIcon platform={a.platform} className="size-4 text-[7px]" /></div>
        <div className="text-[11px] text-muted-foreground">{PLATFORM_LABEL[a.platform]}{!a.connected && " · reconnect needed"}</div>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Max/day
        <Input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(+e.target.value)} onBlur={() => limit !== a.daily_limit && save({ daily_limit: limit })} className="h-7 w-16" />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Min gap (min)
        <Input type="number" min={5} value={gap} onChange={(e) => setGap(+e.target.value)} onBlur={() => gap !== a.min_interval_minutes && save({ min_interval_minutes: gap })} className="h-7 w-20" />
      </label>
      <Switch checked={a.enabled} onCheckedChange={(v) => save({ enabled: v })} title="Enabled" />
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={async () => {
          if (!confirm(`Remove ${a.display_name}? Its scheduled posts are removed too.`)) return;
          await api.deleteAccount(a.id);
          onChange();
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

export default function PublishHub() {
  const { data: info } = useSWR<PlatformsInfo>("/api/platforms", fetcher);
  const { data: accounts, mutate } = useSWR<Account[]>("/api/accounts", fetcher);
  const byPlatform = (p: Platform) => (accounts ?? []).filter((a) => a.platform === p);

  return (
    <div className="mx-auto max-w-5xl">
      <Suspense><OAuthToasts /></Suspense>
      <PageHeader
        title="Auto-Publish Hub"
        description="Connect as many accounts as you like. Each login can be repeated with a different account; one Meta login imports every Page and Instagram account you manage."
      />
      {info?.dry_run && (
        <Card className="mb-6 border-warning/40 bg-warning/5 py-4">
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <FlaskConical className="size-5 text-warning" />
            <span className="flex-1">Dry-run mode is on (PUBLISH_DRY_RUN=true): posts are simulated. Add sandbox accounts to test the scheduler.</span>
            {(["tiktok", "youtube", "instagram", "facebook"] as Platform[]).map((p) => (
              <Button key={p} size="sm" variant="outline" onClick={async () => { await api.addSandbox(p); mutate(); }}>
                <PlatformIcon platform={p} className="size-4 text-[7px]" /> + sandbox
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {info?.providers.map((p) => (
          <Card key={p.slug} className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {p.platforms.map((pl) => <PlatformIcon key={pl} platform={pl} />)} {p.label}
              </CardTitle>
              <CardDescription>
                {p.platforms.reduce((n, pl) => n + byPlatform(pl).length, 0)} connected
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {p.configured ? (
                <Button asChild><a href={api.oauthStartUrl(p.slug)}><Plug /> Connect account</a></Button>
              ) : (
                <>
                  <Badge variant="warning">Not configured</Badge>
                  <p className="text-xs text-muted-foreground">
                    Create a developer app, then set <code className="text-foreground">{p.env_keys.join(", ")}</code> in <code>backend/.env</code>. Redirect URI:
                  </p>
                  <code className="rounded bg-muted px-2 py-1 text-[11px] break-all">{p.redirect_uri}</code>
                </>
              )}
              <a href={p.docs_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">API docs <ExternalLink className="size-3" /></a>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-semibold">Connected accounts</h2>
      {!accounts ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No accounts yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {accounts.map((a) => <AccountRow key={a.id} a={a} onChange={() => mutate()} />)}
        </div>
      )}
    </div>
  );
}
