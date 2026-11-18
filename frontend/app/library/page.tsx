"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { Film, Search } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { ClipCard } from "@/components/clip-card";
import { ClipStudio } from "@/components/clip-studio";
import { fetcher, type Clip } from "@/lib/api";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "unposted", label: "Not posted yet" },
  { key: "posted", label: "Posted" },
  { key: "all", label: "All" },
] as const;

export default function LibraryPage() {
  const { data: clips, mutate } = useSWR<Clip[]>("/api/clips", fetcher);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("pending");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (clips ?? []).filter((c) => {
      const posted = Object.keys(c.posted ?? {}).length > 0;
      const ok =
        filter === "all" ||
        (filter === "posted" && posted) ||
        (filter === "unposted" && c.review_status === "approved" && !posted) ||
        c.review_status === filter;
      return ok && (!term || c.title.toLowerCase().includes(term) || c.hashtags.join(" ").toLowerCase().includes(term));
    });
  }, [clips, filter, q]);

  const update = (c: Clip) => mutate((l) => l?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Clips" description="Every rendered clip across your projects. Review them, grab the captions, and post them yourself." />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} className={cn("relative shrink-0 rounded-full px-4 py-1.5 text-sm transition", filter === f.key ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {filter === f.key && <motion.span layoutId="lib-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" />}
              <span className="relative">{f.label}</span>
            </button>
          ))}
        </div>
        <label className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[.03] px-4 text-sm sm:ml-auto sm:w-72">
          <Search className="size-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles and hashtags" className="flex-1 bg-transparent outline-none" />
        </label>
      </div>
      {!clips ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton aspect-[9/16] rounded-2xl" />)}</div>
      ) : shown.length === 0 ? (
        <div className="glass rounded-3xl border border-dashed p-12 text-center text-sm text-muted-foreground"><Film className="mx-auto mb-2 size-7 text-primary" />No clips here.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((c, i) => <ClipCard key={c.id} clip={c} index={i} onChange={update} onOpen={() => setOpen(i)} />)}
        </div>
      )}
      <ClipStudio clips={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onChange={update} />
    </div>
  );
}
