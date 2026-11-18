"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { CaptionsOff, Check, ExternalLink, Music2, Plus, RotateCw } from "lucide-react";
import { CaptionPreview } from "@/components/caption-preview";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { fetcher, type CaptionStyle, type GenerationSettings, type MusicTrack, type Presets } from "@/lib/api";
import { cn } from "@/lib/utils";

const MODE_NAME: Record<CaptionStyle["mode"], string> = { chunk: "Phrase + highlight", stack: "Lead + keyword", word: "Word by word" };
const RATIO_NAME: Record<string, string> = { "9:16": "Tall", "4:5": "Portrait", "1:1": "Square", "16:9": "Wide" };

/*
 * Layout note: everything here is sized by the WIDTH OF THE SELECTOR (container queries: @md, @lg, @2xl),
 * not by the screen, because the same component sits in a full-screen sheet on phones and in dialogs of
 * different widths on desktop.
 */
const card =
  "relative min-w-0 rounded-lg border transition-[color,background-color,border-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.98]";
const cardOn = "border-primary bg-primary/10 ring-1 ring-primary";
const toggle = "min-h-9 py-1 leading-snug font-normal pointer-coarse:min-h-11";
// the padding is part of the slider, so the whole 40px (44px on touch) strip can be grabbed, not just the thin track
const slider = "py-[1.0625rem] pointer-coarse:py-[1.1875rem]";

/** Check mark on the corner of the picked card (it sits on the border, so it never covers the content). */
function Picked() {
  return (
    <span aria-hidden className="absolute -top-1.5 -right-1.5 z-10 grid size-[1.125rem] place-items-center rounded-full bg-primary text-primary-foreground shadow-md">
      <Check className="size-3" strokeWidth={3.5} />
    </span>
  );
}

function Heading({ children, hint, className }: { children: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5", className)}>
      <h3 className="text-sm font-semibold">{children}</h3>
      {hint && <p className="min-w-0 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Small 9:16 diagram of how each layout arranges the frame. Drawn in percentages, so it works at any size. */
function LayoutDiagram({ layout, className }: { layout: string; className?: string }) {
  const pane = "absolute inset-x-[9%] rounded-[2px]";
  const face = "absolute left-1/2 aspect-square -translate-x-1/2 rounded-full";
  return (
    <span aria-hidden className={cn("relative block aspect-[9/16] shrink-0 overflow-hidden rounded-md border bg-muted", className)}>
      {layout === "split_faces" && (
        <>
          <span className={cn(pane, "top-[5%] h-[43%] bg-primary/45")} />
          <span className={cn(face, "top-[15%] w-[30%] bg-primary")} />
          <span className={cn(pane, "bottom-[5%] h-[43%] bg-fuchsia-400/45")} />
          <span className={cn(face, "bottom-[17%] w-[30%] bg-fuchsia-300")} />
        </>
      )}
      {layout === "gameplay_facecam" && (
        <>
          <span className={cn(pane, "top-[5%] h-[52%] bg-sky-400/50")} />
          <span className="absolute top-[12%] left-[20%] h-[5%] w-[36%] rounded-full bg-sky-200/80" />
          <span className="absolute top-[42%] right-[20%] h-[7%] w-[14%] rounded-[1px] bg-sky-200/80" />
          <span className={cn(pane, "bottom-[5%] h-[35%] bg-primary/45")} />
          <span className={cn(face, "bottom-[13%] w-[30%] bg-primary")} />
        </>
      )}
      {layout === "blur_fill" && (
        <>
          <span className="absolute inset-0 bg-gradient-to-b from-zinc-500/40 to-zinc-800/40" />
          <span className="absolute inset-x-[14%] top-[13%] h-[11%] rounded-[2px] bg-white" />
          <span className="absolute inset-x-0 top-[36%] h-[30%] bg-primary/60" />
        </>
      )}
      {layout === "face_track" && (
        <>
          <span className={cn(pane, "inset-y-[5%] bg-primary/30")} />
          <span className={cn(face, "top-[25%] w-[52%] border border-dashed border-white/80")} />
          <span className={cn(face, "top-[30.5%] w-[32%] bg-primary")} />
        </>
      )}
      {layout === "face_static" && (
        <>
          <span className={cn(pane, "inset-y-[5%] bg-primary/30")} />
          <span className={cn(face, "top-[26%] w-[34%] bg-primary")} />
          <span className="absolute inset-x-[20%] top-[52%] bottom-[5%] rounded-t-full bg-primary/60" />
        </>
      )}
      {!["split_faces", "gameplay_facecam", "blur_fill", "face_track", "face_static"].includes(layout) && (
        <>
          <span className={cn(pane, "inset-y-[5%] bg-primary/30")} />
          <span className="absolute inset-x-[30%] top-1/2 h-px -translate-y-1/2 bg-white/80" />
          <span className="absolute inset-y-[41%] left-1/2 w-px -translate-x-1/2 bg-white/80" />
        </>
      )}
    </span>
  );
}

/** Same shape as the loaded selector, so the dialog does not jump when the styles arrive. */
function SelectorSkeleton() {
  return (
    <div className="@container" aria-busy="true" aria-label="Loading styles">
      <div className="flex flex-col gap-6">
        <div>
          <div className="skeleton mb-2.5 h-5 w-40 rounded" />
          <div className="grid grid-cols-3 gap-2 @2xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, k) => (
              <div key={k} className="skeleton h-[6.75rem] rounded-lg" />
            ))}
          </div>
          <div className="skeleton mt-2 h-4 w-3/4 rounded" />
        </div>
        <div>
          <div className="skeleton mb-2.5 h-5 w-40 rounded" />
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, k) => (
              <div key={k} className="skeleton aspect-[5/3.2] rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StyleSelector({ value, onChange }: { value: GenerationSettings; onChange: (v: GenerationSettings) => void }) {
  // presets never change while the app is open
  const { data: presets, error, mutate: retry, isValidating } = useSWR<Presets>("/api/presets", fetcher, { revalidateOnFocus: false, revalidateIfStale: false });
  // songs do: they are refetched when the user comes back from the Music page in another tab
  const { data: music } = useSWR<MusicTrack[]>("/api/music", fetcher);
  const [peek, setPeek] = useState<string | null>(null); // editing style under the mouse or keyboard focus
  const [hover, setHover] = useState<string | null>(null); // caption style under the mouse
  const set = <K extends keyof GenerationSettings>(k: K, v: GenerationSettings[K]) => onChange({ ...value, [k]: v });

  if (!presets) {
    if (!error) return <SelectorSkeleton />;
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">The styles did not load. Check your connection and try again.</p>
        <Button variant="outline" onClick={() => retry()} disabled={isValidating} className="pointer-coarse:h-11">
          <RotateCw className={cn(isValidating && "animate-spin")} /> Try again
        </Button>
      </div>
    );
  }

  const shown = presets.editing_styles.find((s) => s.key === peek) ?? presets.editing_styles.find((s) => s.key === value.editing_style);
  const mouse = (e: React.PointerEvent) => e.pointerType === "mouse";

  return (
    <div className="@container">
      <div className="flex flex-col gap-6">
        {/* 1. Editing style */}
        <section>
          <Heading hint="How the wide video is fitted into a tall one.">1. Editing style</Heading>
          <div className="grid grid-cols-3 gap-2 @2xl:grid-cols-6">
            {presets.editing_styles.map((s) => {
              const on = value.editing_style === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("editing_style", s.key)}
                  onPointerEnter={(e) => mouse(e) && setPeek(s.key)}
                  onPointerLeave={() => setPeek(null)}
                  onFocus={() => setPeek(s.key)}
                  onBlur={() => setPeek(null)}
                  className={cn(card, "flex flex-col items-center gap-1.5 px-1.5 pt-2.5 pb-2 text-center hover:bg-accent/60", on && cardOn)}
                >
                  <LayoutDiagram layout={s.layout} className="h-14 @md:h-16" />
                  <span className="max-w-full text-xs leading-tight font-medium text-balance wrap-anywhere @md:text-[0.8125rem]">{s.name}</span>
                  <span className="sr-only">. {s.description}</span>
                  {on && <Picked />}
                </button>
              );
            })}
          </div>
          {/* What the picked (or pointed at) style does. Every description is stacked in the same cell,
              so the tallest one decides the height and picking another style never moves what is below. */}
          <div aria-hidden className="mt-2 grid rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
            {presets.editing_styles.map((s) => (
              <p key={s.key} className={cn("col-start-1 row-start-1", s.key !== shown?.key && "invisible")}>
                <span className="font-medium text-foreground">{s.name}.</span> {s.description}
              </p>
            ))}
          </div>
        </section>

        {/* 2. Caption style */}
        {/* wide: the two switches sit at the right end of the heading row; narrow: under the tiles */}
        <section className="@2xl:grid @2xl:grid-cols-[minmax(0,1fr)_auto] @2xl:items-center @2xl:gap-x-6">
          <Heading hint="Pick one to watch it play." className="@2xl:mb-0">2. Caption style</Heading>
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4 @2xl:col-span-2 @2xl:row-start-2 @2xl:mt-1.5">
            {presets.caption_styles.map((c) => {
              const on = value.caption_style === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("caption_style", c.key)}
                  onPointerEnter={(e) => mouse(e) && setHover(c.key)}
                  onPointerLeave={() => setHover(null)}
                  className={cn(card, "flex flex-col text-left hover:border-primary/60", on && "border-primary ring-1 ring-primary")}
                >
                  <span
                    data-caption-tile={c.key}
                    className="@container-[size] block aspect-[5/2] w-full overflow-hidden rounded-t-[calc(var(--radius)-1px)] bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-900"
                  >
                    <CaptionPreview style={c} animate={on || hover === c.key} />
                  </span>
                  <span className="block px-2 py-1.5">
                    <span className="line-clamp-2 text-xs leading-tight font-medium wrap-anywhere">{c.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{MODE_NAME[c.mode] ?? "Captions"}</span>
                  </span>
                  {on && <Picked />}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={value.caption_style === "none"}
              onClick={() => set("caption_style", "none")}
              className={cn(card, "flex flex-col text-left hover:border-primary/60", value.caption_style === "none" && "border-primary ring-1 ring-primary")}
            >
              <span className="grid aspect-[5/2] w-full place-items-center rounded-t-[calc(var(--radius)-1px)] bg-muted/40 text-muted-foreground">
                <CaptionsOff className="size-6" aria-hidden />
              </span>
              <span className="block px-2 py-1.5">
                <span className="block text-xs leading-tight font-medium">No captions</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">Video only</span>
              </span>
              {value.caption_style === "none" && <Picked />}
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-0.5 @2xl:col-start-2 @2xl:row-start-1 @2xl:mt-0">
            <Label className={toggle}>
              <Switch checked={value.auto_emoji} onCheckedChange={(v) => set("auto_emoji", v)} /> Add emojis
            </Label>
            <Label className={toggle}>
              <Switch checked={value.hook_title} onCheckedChange={(v) => set("hook_title", v)} /> Hook title on every clip
            </Label>
          </div>
        </section>

        {/* 3. Shape + 4. Length */}
        <div className="grid gap-x-8 gap-y-6 @2xl:grid-cols-2">
          <section>
            <Heading>3. Shape</Heading>
            <div className="flex flex-wrap gap-2">
              {presets.aspect_ratios.map((a) => {
                const on = value.aspect_ratio === a.key;
                return (
                  <button
                    key={a.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("aspect_ratio", a.key)}
                    className={cn(card, "flex min-h-10 flex-1 items-center justify-center gap-2 px-3 text-sm whitespace-nowrap hover:bg-accent/60 @md:flex-none pointer-coarse:min-h-11", on && "border-primary bg-primary/10")}
                  >
                    <span aria-hidden className="inline-block shrink-0 rounded-[2px] border-2 border-current" style={{ width: Math.round((a.width / a.height) * 18), height: 18 }} />
                    <span className="font-medium tabular-nums">{a.key}</span>
                    {RATIO_NAME[a.key] && <span className="text-xs text-muted-foreground @max-md:hidden">{RATIO_NAME[a.key]}</span>}
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <Heading hint="Best between 15 and 60 seconds.">
              4. Clip length{" "}
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                {value.min_duration}s to {value.max_duration}s
              </span>
            </Heading>
            <Slider
              className={slider}
              min={5}
              max={120}
              step={5}
              minStepsBetweenThumbs={1}
              value={[value.min_duration, value.max_duration]}
              onValueChange={([a, b]) => onChange({ ...value, min_duration: Math.min(a, 115), max_duration: Math.min(120, Math.max(b, a + 5)) })}
            />
          </section>
        </div>

        {/* 5. Music */}
        <section>
          <Heading hint="Optional. Pick one or more songs and they take turns across your clips.">5. Background music</Heading>
          <div className="flex flex-wrap gap-2">
            {music?.map((m) => {
              const on = value.music_track_ids.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={on}
                  title={m.name}
                  onClick={() => set("music_track_ids", on ? value.music_track_ids.filter((x) => x !== m.id) : [...value.music_track_ids, m.id])}
                  className={cn(
                    "flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring active:scale-[.98] pointer-coarse:min-h-11 pointer-coarse:text-sm",
                    on && "border-primary bg-primary/15",
                  )}
                >
                  {on ? <Check className="size-3.5 shrink-0 text-primary" strokeWidth={3} aria-hidden /> : <Music2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 truncate">{m.name}</span>
                  {m.bpm ? <span className="shrink-0 text-muted-foreground tabular-nums">{Math.round(m.bpm)} bpm</span> : null}
                </button>
              );
            })}
            {/* a new tab, so the video and the choices made here are not lost */}
            <Link
              href="/music"
              target="_blank"
              rel="noopener"
              className="flex min-h-9 items-center gap-1.5 rounded-full border border-dashed px-3 text-xs text-muted-foreground transition-colors outline-none hover:border-primary/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:text-sm"
            >
              <Plus className="size-3.5 shrink-0" aria-hidden /> {music?.length ? "Add songs" : "Add songs in the Music library"}
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </Link>
            {music?.length === 0 && <p className="min-w-0 self-center text-xs text-muted-foreground">No songs yet. It opens in a new tab, so your choices here are kept.</p>}
          </div>
          {value.music_track_ids.length > 0 && (
            <div className="mt-4 grid gap-x-8 gap-y-2 @2xl:grid-cols-2">
              <div>
                <Label className="font-normal">
                  Music volume <span className="text-muted-foreground tabular-nums">{Math.round(value.music_volume * 100)}%</span>
                </Label>
                <Slider className={slider} min={0} max={60} step={1} value={[Math.round(value.music_volume * 100)]} onValueChange={([v]) => set("music_volume", v / 100)} />
              </div>
              <div className="flex flex-col gap-y-0.5">
                <Label className={toggle}>
                  <Switch checked={value.ducking} onCheckedChange={(v) => set("ducking", v)} /> Lower the music when someone speaks
                </Label>
                <Label className={toggle}>
                  <Switch checked={value.match_drop_to_hook} onCheckedChange={(v) => set("match_drop_to_hook", v)} /> Land the beat drop on the hook
                </Label>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
