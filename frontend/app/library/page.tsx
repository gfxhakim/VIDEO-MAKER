"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { toast } from "sonner";
import { CheckSquare, Film, RotateCcw, Search, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { CLIP_GRID, ClipCard, ClipGridSkeleton } from "@/components/clip-card";
import { ClipStudio, useClipStudio } from "@/components/clip-studio";
import { Button } from "@/components/ui/button";
import { api, fetcher, type Clip, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "unposted", label: "To post" },
  { key: "posted", label: "Posted" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];
type SortKey = "newest" | "score" | "duration";

const isPosted = (c: Clip) => Object.keys(c.posted ?? {}).length > 0;
function matches(c: Clip, f: Filter) {
  if (f === "all") return true;
  if (f === "posted") return isPosted(c);
  if (f === "unposted") return c.review_status === "approved" && !isPosted(c);
  return c.review_status === f;
}

const PAGE = 48;

export default function LibraryPage() {
  const { data: clips, error, mutate } = useSWR<Clip[]>("/api/clips", fetcher);
  const { data: projects } = useSWR<Project[]>("/api/projects", fetcher);
  const [picked, setPicked] = useState<Filter | null>(null);
  const loaded = !!clips;
  const hasPending = !!clips?.some((c) => c.review_status === "pending");
  useEffect(() => {
    if (loaded) setPicked((p) => p ?? (hasPending ? "pending" : "all"));
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter: Filter = picked ?? "pending";

  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const term = dq.trim().toLowerCase();

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const projectAspects = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects ?? []) m.set(p.id, p.settings?.aspect_ratio || "9:16");
    return m;
  }, [projects]);

  const projectSettingsMap = useMemo(() => {
    const m = new Map<number, Project["settings"]>();
    for (const p of projects ?? []) m.set(p.id, p.settings);
    return m;
  }, [projects]);

  const counts = useMemo(() => {
    const n = {} as Record<Filter, number>;
    for (const f of FILTERS) n[f.key] = (clips ?? []).filter((c) => matches(c, f.key)).length;
    return n;
  }, [clips]);

  const shown = useMemo(() => {
    const list = (clips ?? []).filter(
      (c) =>
        matches(c, filter) &&
        (projectFilter === "all" || c.project_id === Number(projectFilter)) &&
        (!term ||
          c.title.toLowerCase().includes(term) ||
          c.description.toLowerCase().includes(term) ||
          c.transcript.toLowerCase().includes(term) ||
          c.hashtags.join(" ").toLowerCase().includes(term)),
    );
    if (sort === "score") return [...list].sort((a, b) => b.score - a.score);
    if (sort === "duration") return [...list].sort((a, b) => b.duration - a.duration);
    return list;
  }, [clips, filter, projectFilter, term, sort]);

  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, term, projectFilter, sort]);
  const more = useRef<HTMLDivElement>(null);
  const hasMore = shown.length > limit;
  useEffect(() => {
    const el = more.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit((l) => l + PAGE), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, limit]);

  const studio = useClipStudio(clips, shown);
  const update = useCallback((c: Clip) => {
    void mutate((l) => l?.map((x) => (x.id === c.id ? c : x)), { revalidate: false });
  }, [mutate]);
  const remove = useCallback((cid: number) => {
    void mutate((l) => l?.filter((x) => x.id !== cid), { revalidate: false });
  }, [mutate]);

  const toggleSelect = useCallback((cid: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }, []);

  async function runBulk(action: "approve" | "reject" | "delete") {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (action === "delete" && !window.confirm(`Delete ${ids.length} selected clip(s)?`)) return;
    setBulkBusy(true);
    try {
      await api.bulkClips(ids, action);
      setSelected(new Set());
      setSelectMode(false);
      await mutate();
      toast.success(`Updated ${ids.length} clip(s)`);
    } catch (e) {
      toast.error("Bulk action failed", { description: (e as Error).message });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Clips" description="Every finished clip from all your projects. Search transcripts, bulk-review, grab captions, and post them yourself." />

      <div className="mb-5 flex flex-col gap-3 sm:mb-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div role="group" aria-label="Show" className="flex min-w-0 flex-wrap gap-0.5 sm:gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setPicked(f.key)}
                className={cn(
                  "relative min-w-0 rounded-full px-2.5 py-1.5 text-[0.8125rem] whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[.97] sm:px-4 sm:text-sm pointer-coarse:min-h-10",
                  filter === f.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filter === f.key && <motion.span layoutId="lib-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" transition={{ duration: 0.2 }} />}
                <span className="relative">{f.label}{clips && <span className="text-muted-foreground tabular-nums max-sm:hidden"> {counts[f.key]}</span>}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {projects && projects.length > 1 && (
              <select
                aria-label="Filter by project"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="h-10 max-w-48 rounded-full border border-white/10 bg-zinc-900 px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All projects</option>
                {projects.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
              </select>
            )}
            <select
              aria-label="Sort clips"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-10 rounded-full border border-white/10 bg-zinc-900 px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="newest">Newest</option>
              <option value="score">Highest score</option>
              <option value="duration">Longest</option>
            </select>
            <Button
              variant={selectMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelected(new Set());
              }}
              className="h-10 rounded-full px-3.5 text-xs"
            >
              <CheckSquare className="size-3.5" /> {selectMode ? "Done" : "Select"}
            </Button>
            <label className="flex h-10 w-full shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[.03] pr-1 pl-4 text-sm transition-colors focus-within:border-white/30 sm:w-64 pointer-coarse:h-11">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="search"
                enterKeyHint="search"
                aria-label="Search titles, transcripts and hashtags"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, words, #tag"
                className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground pointer-coarse:text-base [&::-webkit-search-cancel-button]:hidden"
              />
              {q && (
                <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground pointer-coarse:size-10">
                  <X className="size-4" />
                </button>
              )}
            </label>
          </div>
        </div>

        {selectMode && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-xs">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set(shown.map((c) => c.id)))}>Select all ({shown.length})</Button>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" disabled={!selected.size || bulkBusy} onClick={() => runBulk("approve")}><ThumbsUp className="size-3.5" /> Approve</Button>
              <Button size="sm" variant="secondary" disabled={!selected.size || bulkBusy} onClick={() => runBulk("reject")}><ThumbsDown className="size-3.5" /> Reject</Button>
              <Button size="sm" variant="destructive" disabled={!selected.size || bulkBusy} onClick={() => runBulk("delete")}><Trash2 className="size-3.5" /> Delete</Button>
            </div>
          </div>
        )}
      </div>

      {!clips ? (
        error ? (
          <div className="glass max-w-xl rounded-3xl border p-6 sm:p-8">
            <p className="font-medium">Could not load your clips</p>
            <p className="mt-1 text-sm wrap-anywhere text-muted-foreground">Check your connection and try again. ({(error as Error).message || "No answer from the server"})</p>
            <Button variant="outline" className="mt-4 pointer-coarse:h-11" onClick={() => mutate()}><RotateCcw /> Try again</Button>
          </div>
        ) : (
          <ClipGridSkeleton count={10} />
        )
      ) : shown.length === 0 ? (
        <div className="glass rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground sm:p-12">
          <Film className="mx-auto mb-2 size-7 text-primary" />
          {clips.length === 0 ? (
            <>
              <p>No clips yet. They show up here when a project finishes.</p>
              <Button asChild size="sm" className="mt-3 pointer-coarse:h-10"><Link href="/">Make your first clips</Link></Button>
            </>
          ) : term ? (
            <>
              <p className="wrap-anywhere">No clips match “{dq.trim()}”{filter !== "all" && <> in {FILTERS.find((f) => f.key === filter)?.label}</>}.</p>
              <Button variant="outline" size="sm" className="mt-3 pointer-coarse:h-10" onClick={() => setQ("")}>Clear search</Button>
            </>
          ) : (
            <>
              <p>Nothing in {FILTERS.find((f) => f.key === filter)?.label} right now.</p>
              <Button variant="outline" size="sm" className="mt-3 pointer-coarse:h-10" onClick={() => setPicked("all")}>Show all {clips.length} clips</Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className={CLIP_GRID}>
            {shown.slice(0, limit).map((c, i) => (
              <ClipCard
                key={c.id}
                clip={c}
                index={i % PAGE}
                ratio={projectAspects.get(c.project_id)}
                selectable={selectMode}
                selected={selected.has(c.id)}
                onToggleSelect={toggleSelect}
                onChange={update}
                onOpen={(cid) => studio.open(cid, "publish")}
                onEdit={(cid) => studio.open(cid, "edit")}
              />
            ))}
          </div>
          {hasMore && (
            <div ref={more} className="mt-6 flex justify-center">
              <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setLimit((l) => l + PAGE)}>Show more ({shown.length - limit} left)</Button>
            </div>
          )}
        </>
      )}

      <ClipStudio
        clips={studio.clips}
        index={studio.index}
        initialTab={studio.tab}
        projectAspect={studio.index != null && studio.clips[studio.index] ? projectAspects.get(studio.clips[studio.index].project_id) : undefined}
        projectSettings={studio.index != null && studio.clips[studio.index] ? projectSettingsMap.get(studio.clips[studio.index].project_id) : undefined}
        onOpen={studio.open}
        onClose={studio.close}
        onChange={update}
        onDelete={remove}
      />
    </>
  );
}
