"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { Film, RotateCcw, Search, X } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { CLIP_GRID, ClipCard, ClipGridSkeleton } from "@/components/clip-card";
import { ClipStudio, useClipStudio } from "@/components/clip-studio";
import { Button } from "@/components/ui/button";
import { fetcher, type Clip } from "@/lib/api";
import { cn } from "@/lib/utils";

// "All" comes first so it can never end up off-screen.
const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "unposted", label: "To post" },
  { key: "posted", label: "Posted" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const isPosted = (c: Clip) => Object.keys(c.posted ?? {}).length > 0;
function matches(c: Clip, f: Filter) {
  if (f === "all") return true;
  if (f === "posted") return isPosted(c);
  if (f === "unposted") return c.review_status === "approved" && !isPosted(c);
  return c.review_status === f;
}

/** Cards drawn at first, and added each time the end of the list comes near. */
const PAGE = 48;

export default function LibraryPage() {
  const { data: clips, error, mutate } = useSWR<Clip[]>("/api/clips", fetcher);
  // Start on "To review" when there is something to review, otherwise on "All" (never on an empty page).
  const [picked, setPicked] = useState<Filter | null>(null);
  const loaded = !!clips;
  const hasPending = !!clips?.some((c) => c.review_status === "pending");
  useEffect(() => {
    if (loaded) setPicked((p) => p ?? (hasPending ? "pending" : "all"));
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter: Filter = picked ?? "pending";

  const [q, setQ] = useState("");
  const dq = useDeferredValue(q); // typing stays smooth while a long list re-filters
  const term = dq.trim().toLowerCase();

  const counts = useMemo(() => {
    const n = {} as Record<Filter, number>;
    for (const f of FILTERS) n[f.key] = (clips ?? []).filter((c) => matches(c, f.key)).length;
    return n;
  }, [clips]);
  const shown = useMemo(
    () => (clips ?? []).filter((c) => matches(c, filter) && (!term || c.title.toLowerCase().includes(term) || c.hashtags.join(" ").toLowerCase().includes(term))),
    [clips, filter, term],
  );

  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, term]);
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

  return (
    <>
      <PageHeader title="Clips" description="Every finished clip from all your projects. Review them, grab the captions, and post them yourself." />

      <div className="mb-5 flex flex-col gap-3 sm:mb-6 xl:flex-row xl:items-center xl:justify-between">
        <div role="group" aria-label="Show" className="flex min-w-0 gap-0.5 sm:flex-wrap sm:gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setPicked(f.key)}
              className={cn(
                "relative min-w-0 rounded-full px-1.5 py-1.5 text-[0.8125rem] whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[.97] max-sm:flex-auto sm:px-4 sm:text-sm pointer-coarse:min-h-10 pointer-coarse:min-w-10",
                filter === f.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filter === f.key && <motion.span layoutId="lib-filter" className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/15" transition={{ duration: 0.2 }} />}
              <span className="relative">{f.label}{clips && <span className="text-muted-foreground tabular-nums max-sm:hidden"> {counts[f.key]}</span>}</span>
            </button>
          ))}
        </div>
        <label className="flex h-10 w-full shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[.03] pr-1 pl-4 text-sm transition-colors focus-within:border-white/30 xl:w-72 pointer-coarse:h-11">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            enterKeyHint="search"
            aria-label="Search titles and hashtags"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles and hashtags"
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground pointer-coarse:text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground pointer-coarse:size-10">
              <X className="size-4" />
            </button>
          )}
        </label>
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
            {shown.slice(0, limit).map((c, i) => <ClipCard key={c.id} clip={c} index={i % PAGE} onChange={update} onOpen={studio.open} />)}
          </div>
          {hasMore && (
            <div ref={more} className="mt-6 flex justify-center">
              <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setLimit((l) => l + PAGE)}>Show more ({shown.length - limit} left)</Button>
            </div>
          )}
        </>
      )}

      <ClipStudio clips={studio.clips} index={studio.index} onOpen={studio.open} onClose={studio.close} onChange={update} />
    </>
  );
}
