"use client";

import { useState } from "react";
import useSWR from "swr";
import { Rocket } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { ClipCard } from "@/components/clip-card";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetcher, type Clip } from "@/lib/api";

export default function ReviewPage() {
  const [filter, setFilter] = useState("pending");
  const { data: clips, mutate } = useSWR<Clip[]>(`/api/clips${filter === "all" ? "" : `?review_status=${filter}`}`, fetcher);
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Review clips"
        description="Approve, reject, or edit titles and tags across every project, then push the winners to your accounts."
        actions={<Button disabled={!selected.length} onClick={() => setOpen(true)}><Rocket /> Publish {selected.length || ""} selected</Button>}
      />
      <Tabs value={filter} onValueChange={(v) => { setFilter(v); setSelected([]); }} className="mb-5">
        <TabsList>
          <TabsTrigger value="pending">To review</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      {!clips ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : clips.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {clips.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              selected={selected.includes(c.id)}
              onSelect={(v) => setSelected((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
              onChange={() => mutate()}
            />
          ))}
        </div>
      )}
      <ScheduleDialog open={open} onOpenChange={setOpen} clipIds={selected} onDone={() => { setSelected([]); mutate(); }} />
    </div>
  );
}
