"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Ban, ExternalLink, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, fetcher, type PublishJob } from "@/lib/api";
import { fmtDate } from "@/lib/utils";

const STATUS_VARIANT = {
  scheduled: "secondary",
  publishing: "warning",
  published: "success",
  failed: "destructive",
  cancelled: "outline",
} as const;

export default function QueuePage() {
  const [filter, setFilter] = useState("");
  const { data: jobs, mutate } = useSWR<PublishJob[]>(`/api/publish/jobs${filter ? `?status=${filter}` : ""}`, fetcher, { refreshInterval: 5000 });

  async function act(id: number, status: "cancelled" | "scheduled") {
    try {
      await api.updatePublishJob(id, status === "scheduled" ? { status, scheduled_at: new Date().toISOString() } : { status });
      mutate();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Schedule queue" description="Every planned post. Times are shown in your local time zone; the scheduler may nudge a post later to respect per-account limits." />
      <Tabs value={filter || "all"} onValueChange={(v) => setFilter(v === "all" ? "" : v)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="publishing">Publishing</TabsTrigger>
          <TabsTrigger value="published">Published</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>
      </Tabs>
      {!jobs ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">The queue is empty. Select clips on a project or the Review page and press Publish.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-3 border-b bg-card px-3 py-2 last:border-0">
              {j.thumb_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={j.thumb_url} alt="" className="h-12 w-7 rounded object-cover" />
              ) : <div className="h-12 w-7 rounded bg-muted" />}
              <div className="min-w-40 flex-1">
                <div className="truncate text-sm">{j.clip_title}</div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><PlatformIcon platform={j.platform} className="size-4 text-[7px]" />{j.account_name}</div>
                {j.error && <div className="mt-0.5 line-clamp-2 text-[11px] text-destructive">{j.error}</div>}
              </div>
              <div className="w-36 text-right text-xs tabular-nums text-muted-foreground">{fmtDate(j.published_at ?? j.scheduled_at)}</div>
              <Badge variant={STATUS_VARIANT[j.status]} className="w-20">{j.status}</Badge>
              <div className="flex w-20 justify-end">
                {j.status === "scheduled" && <Button size="icon" variant="ghost" className="size-8" title="Cancel" onClick={() => act(j.id, "cancelled")}><Ban /></Button>}
                {(j.status === "failed" || j.status === "cancelled") && <Button size="icon" variant="ghost" className="size-8" title="Retry now" onClick={() => act(j.id, "scheduled")}><RotateCcw /></Button>}
                {j.remote_url && <Button size="icon" variant="ghost" className="size-8" asChild><a href={j.remote_url} target="_blank" rel="noreferrer"><ExternalLink /></a></Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
