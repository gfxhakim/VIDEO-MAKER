"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { CaptionsOff, Check, ExternalLink, Film, Gauge, Music2, Plus, RotateCw, SlidersHorizontal, Sparkles, Wand2 } from "lucide-react";
import { CaptionPreview } from "@/components/caption-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  fetcher,
  type BrollClip,
  type CaptionStyle,
  type GenerationSettings,
  type HookCardStyle,
  type MusicTrack,
  type Presets,
  type VideoEffect,
  type WatermarkPosition,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MODE_NAME: Record<CaptionStyle["mode"], string> = {
  chunk: "Phrase + highlight",
  stack: "Lead + keyword",
  word: "Word by word",
  boxed: "Boxed backdrop",
};
const RATIO_NAME: Record<string, string> = { "9:16": "Tall", "4:5": "Portrait", "1:1": "Square", "16:9": "Wide" };
const LANGUAGES = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "tr", label: "Turkish" },
];
const WM_POSITIONS: { key: WatermarkPosition; label: string }[] = [
  { key: "top_left", label: "Top left" },
  { key: "top_right", label: "Top right" },
  { key: "bottom_left", label: "Bottom left" },
  { key: "bottom_right", label: "Bottom right" },
];

const card =
  "relative min-w-0 rounded-lg border transition-[color,background-color,border-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.98]";
const cardOn = "border-primary bg-primary/10 ring-1 ring-primary";
const toggle = "min-h-9 py-1 leading-snug font-normal pointer-coarse:min-h-11";
const slider = "py-[1.0625rem] pointer-coarse:py-[1.1875rem]";
const SELECT =
  "h-9 rounded-lg border border-white/15 bg-zinc-900 px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:text-sm";

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
      {layout === "broll_split" && (
        <>
          <span className={cn(pane, "top-[5%] h-[48%] bg-primary/45")} />
          <span className={cn(face, "top-[17%] w-[30%] bg-primary")} />
          <span className={cn(pane, "bottom-[5%] h-[39%] bg-emerald-400/45")} />
          <span className="absolute right-[18%] bottom-[16%] left-[18%] h-[12%] rounded-[2px] bg-emerald-200/70" />
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
      {!["split_faces", "gameplay_facecam", "broll_split", "blur_fill", "face_track", "face_static"].includes(layout) && (
        <>
          <span className={cn(pane, "inset-y-[5%] bg-primary/30")} />
          <span className="absolute inset-x-[30%] top-1/2 h-px -translate-y-1/2 bg-white/80" />
          <span className="absolute inset-y-[41%] left-1/2 w-px -translate-x-1/2 bg-white/80" />
        </>
      )}
    </span>
  );
}

function SelectorSkeleton() {
  return (
    <div className="@container" aria-busy="true" aria-label="Loading styles">
      <div className="flex flex-col gap-6">
        <div>
          <div className="skeleton mb-2.5 h-5 w-40 rounded" />
          <div className="grid grid-cols-3 gap-2 @2xl:grid-cols-7">
            {Array.from({ length: 7 }, (_, k) => (
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
  const { data: presets, error, mutate: retry, isValidating } = useSWR<Presets>("/api/presets", fetcher, { revalidateOnFocus: false, revalidateIfStale: false });
  const { data: music } = useSWR<MusicTrack[]>("/api/music", fetcher);
  const { data: broll } = useSWR<BrollClip[]>("/api/broll", fetcher);
  const [peek, setPeek] = useState<string | null>(null);
  const [peekFx, setPeekFx] = useState<string | null>(null);
  const [fxTab, setFxTab] = useState<"all" | "hook" | "grade" | "retro">("all");
  const [hover, setHover] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
  const allEffects: VideoEffect[] = presets.video_effects ?? [
    { key: "none", name: "Clean Original", category: "Base", badge: "Natural", description: "Original camera colors.", preview_filter: "none", preview_tint: "" },
  ];
  const currentFxKey = value.video_effect || "none";
  const shownFx = allEffects.find((f) => f.key === peekFx) ?? allEffects.find((f) => f.key === currentFxKey) ?? allEffects[0];
  const visibleEffects = allEffects.filter((f) => {
    if (fxTab === "all") return true;
    if (fxTab === "hook") return f.key === "none" || f.category === "Hook FX" || f.category === "Motion FX" || f.category === "Trending 2026";
    if (fxTab === "grade") return f.key === "none" || f.category === "Color Grade" || f.category === "Trending 2026";
    return f.key === "none" || f.category === "Retro" || f.category === "Filmic" || f.category === "Mood";
  });
  const speeds = presets.playback_speeds ?? [
    { value: 0.9, label: "0.9x Slow" },
    { value: 1.0, label: "1.0x Normal" },
    { value: 1.05, label: "1.05x Tight" },
    { value: 1.1, label: "1.1x Viral" },
    { value: 1.15, label: "1.15x Fast" },
    { value: 1.25, label: "1.25x Rapid" },
  ];
  const currentSpeed = value.playback_speed ?? 1.0;

  const activeStyle = presets.editing_styles.find((s) => s.key === value.editing_style);
  const hookOn = !!(value.hook_title || activeStyle?.hook_card);
  const isBroll = activeStyle?.layout === "broll_split";
  const capPct = Math.round((value.caption_position ?? 0.65) * 100);
  const mouse = (e: React.PointerEvent) => e.pointerType === "mouse";

  return (
    <div className="@container">
      <div className="flex flex-col gap-6">
        {/* 1. Editing style */}
        <section>
          <Heading hint="How the wide video is fitted into your frame.">1. Editing style</Heading>
          <div className="grid grid-cols-3 gap-2 @lg:grid-cols-4 @2xl:grid-cols-7">
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
          <div aria-hidden className="mt-2 grid rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
            {presets.editing_styles.map((s) => (
              <p key={s.key} className={cn("col-start-1 row-start-1", s.key !== shown?.key && "invisible")}>
                <span className="font-medium text-foreground">{s.name}.</span> {s.description}
              </p>
            ))}
          </div>

          {isBroll && (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[.03] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">Choose B-roll background clip (bottom half)</span>
                <Link href="/music?tab=broll" target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <Plus className="size-3" /> Upload B-roll <ExternalLink className="size-3" />
                </Link>
              </div>
              {broll?.length ? (
                <div className="flex flex-wrap gap-2">
                  {broll.map((b) => {
                    const on = value.broll_id === b.id;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => set("broll_id", on ? null : b.id)}
                        className={cn(
                          "flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
                          on ? "border-primary bg-primary/15 text-foreground" : "border-white/15 text-muted-foreground hover:bg-white/5",
                        )}
                      >
                        <Film className="size-3.5" /> {b.name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No B-roll clips uploaded yet. Without one, this falls back to dynamic face tracking.</p>
              )}
            </div>
          )}
        </section>

        {/* 2. Caption style */}
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
                    <CaptionPreview style={c} animate={on || hover === c.key} showEmoji={value.auto_emoji} />
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
              <Switch checked={value.auto_emoji} onCheckedChange={(v) => set("auto_emoji", v)} /> Add iOS emojis
            </Label>
            <Label className={toggle}>
              <Switch checked={value.hook_title} onCheckedChange={(v) => set("hook_title", v)} /> Hook title on every clip
            </Label>
          </div>
        </section>

        {/* Hook card style + Caption height */}
        {(value.caption_style !== "none" || hookOn) && (
          <section className="grid gap-x-8 gap-y-4 rounded-2xl border border-white/10 bg-white/[.02] p-3.5 @2xl:grid-cols-2">
            {value.caption_style !== "none" && (
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">Caption vertical position</span>
                  <span className="text-muted-foreground tabular-nums">
                    {value.caption_position == null ? "Style default" : `${capPct}% from top`}
                    {value.caption_position != null && (
                      <button type="button" onClick={() => set("caption_position", null)} className="ml-2 text-primary hover:underline">
                        Reset
                      </button>
                    )}
                  </span>
                </div>
                <Slider
                  className={slider}
                  min={15}
                  max={82}
                  step={1}
                  value={[capPct]}
                  onValueChange={([v]) => set("caption_position", v / 100)}
                />
                <p className="text-[11px] text-muted-foreground">Keep between 55%–72% to stay above TikTok/Reels bottom UI.</p>
              </div>
            )}
            {hookOn && (
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <span className="mb-1 block text-xs font-medium">Hook card theme</span>
                  <select
                    aria-label="Hook card theme"
                    value={value.hook_card_style ?? "light"}
                    onChange={(e) => set("hook_card_style", e.target.value as HookCardStyle)}
                    className={SELECT}
                  >
                    {(presets.hook_card_styles ?? [
                      { key: "light", name: "Light pill" },
                      { key: "dark", name: "Dark pill" },
                      { key: "accent", name: "Brand gradient" },
                      { key: "glass", name: "Frosted glass" },
                    ]).map((h) => (
                      <option key={h.key} value={h.key}>{h.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="mb-1 block text-xs font-medium">Show hook for</span>
                  <select
                    aria-label="Hook card duration"
                    value={String(value.hook_card_duration ?? 0)}
                    onChange={(e) => set("hook_card_duration", Number(e.target.value))}
                    className={SELECT}
                  >
                    <option value="0">Entire clip</option>
                    <option value="3">First 3 seconds</option>
                    <option value="5">First 5 seconds</option>
                    <option value="8">First 8 seconds</option>
                  </select>
                </div>
              </div>
            )}
          </section>
        )}

        {/* 3. Trending clipper video effects & clip pacing */}
        <section>
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <Heading
              hint="Applied to the footage only — captions & iOS emojis stay vivid on top."
              className="mb-0"
            >
              <span className="inline-flex items-center gap-1.5"><Wand2 className="size-4 text-primary" /> 3. Trending clipper effects</span>
            </Heading>
            <div role="tablist" aria-label="Filter effect categories" className="flex flex-wrap gap-1 rounded-full bg-white/[.04] p-0.5 text-[11px]">
              {(
                [
                  { id: "all", label: "All FX" },
                  { id: "hook", label: "Hook & Motion" },
                  { id: "grade", label: "Color Grades" },
                  { id: "retro", label: "Retro & Mood" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={fxTab === t.id}
                  onClick={() => setFxTab(t.id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 transition-colors",
                    fxTab === t.id ? "bg-white/15 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-6">
            {visibleEffects.map((fx) => {
              const on = currentFxKey === fx.key;
              return (
                <button
                  key={fx.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("video_effect", fx.key)}
                  onPointerEnter={(e) => mouse(e) && setPeekFx(fx.key)}
                  onPointerLeave={() => setPeekFx(null)}
                  onFocus={() => setPeekFx(fx.key)}
                  onBlur={() => setPeekFx(null)}
                  className={cn(card, "flex flex-col text-left hover:border-primary/60", on && cardOn)}
                >
                  <span className="relative block aspect-[16/9] w-full overflow-hidden rounded-t-[calc(var(--radius)-1px)] bg-zinc-900">
                    <span
                      aria-hidden
                      className="absolute inset-0 block bg-gradient-to-br from-amber-500/75 via-fuchsia-600/65 to-sky-500/80"
                      style={{ filter: fx.preview_filter && fx.preview_filter !== "none" ? fx.preview_filter : undefined }}
                    >
                      <span className="absolute right-3 bottom-1 left-3 h-7 rounded-t-full bg-zinc-950/60" />
                      <span className="absolute top-2.5 left-1/2 size-5 -translate-x-1/2 rounded-full bg-amber-100/90 shadow" />
                    </span>
                    {fx.preview_tint && <span aria-hidden className="absolute inset-0" style={{ background: fx.preview_tint }} />}
                    {fx.badge && (
                      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-xs">
                        {fx.badge}
                      </span>
                    )}
                  </span>
                  <span className="block px-2 py-1.5">
                    <span className="block truncate text-xs font-medium">{fx.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{fx.category}</span>
                  </span>
                  {on && <Picked />}
                </button>
              );
            })}
          </div>
          <div aria-hidden className="mt-2 rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">{shownFx.name}.</span> {shownFx.description}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[.02] px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Gauge className="size-3.5 text-primary" /> Clip pace (speed):
            </span>
            <div className="flex flex-wrap gap-1.5">
              {speeds.map((sp) => {
                const on = Math.abs(currentSpeed - sp.value) < 0.01;
                return (
                  <button
                    key={sp.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("playback_speed", sp.value)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors",
                      on ? "border-primary bg-primary/15 font-medium text-foreground" : "border-white/15 text-muted-foreground hover:bg-white/5 hover:text-foreground",
                    )}
                  >
                    {sp.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* 4. Shape + 5. Length */}
        <div className="grid gap-x-8 gap-y-6 @2xl:grid-cols-2">
          <section>
            <Heading>4. Shape</Heading>
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
            <Heading hint="Between 5 and 180 seconds.">
              5. Clip length{" "}
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                {value.min_duration}s to {value.max_duration}s
              </span>
            </Heading>
            <Slider
              className={slider}
              min={5}
              max={180}
              step={5}
              minStepsBetweenThumbs={1}
              value={[value.min_duration, value.max_duration]}
              onValueChange={([a, b]) => onChange({ ...value, min_duration: Math.min(a, 175), max_duration: Math.min(180, Math.max(b, a + 5)) })}
            />
          </section>
        </div>

        {/* 6. Music */}
        <section>
          <Heading hint="Optional. Pick one or more songs and they take turns across your clips.">6. Background music</Heading>
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
                <Label className={toggle}>
                  <Switch checked={!!value.beat_sync_zoom} onCheckedChange={(v) => set("beat_sync_zoom", v)} /> Snap punch-in zooms to music beats
                </Label>
              </div>
            </div>
          )}
        </section>

        {/* 6. Audio polish, Language & Brand Kit */}
        <section className="rounded-2xl border border-white/10 bg-white/[.02]">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium outline-none hover:bg-white/[.02] focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="size-4 text-primary" /> Audio polish, language & branding
            </span>
            <span className="text-xs text-muted-foreground">{showAdvanced ? "Hide" : "Customize"}</span>
          </button>
          {showAdvanced && (
            <div className="grid gap-5 border-t border-white/10 p-4 @2xl:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label className={toggle}>
                  <Switch checked={value.normalize_audio ?? true} onCheckedChange={(v) => set("normalize_audio", v)} /> Normalize speech loudness (-14 LUFS)
                </Label>
                <Label className={toggle}>
                  <Switch checked={!!value.denoise_audio} onCheckedChange={(v) => set("denoise_audio", v)} /> Reduce background room noise
                </Label>
                <Label className={toggle}>
                  <Switch checked={!!value.remove_silences} onCheckedChange={(v) => set("remove_silences", v)} /> Auto jump-cut awkward silences
                </Label>
                <Label className={toggle}>
                  <Switch checked={!!value.progress_bar} onCheckedChange={(v) => set("progress_bar", v)} /> Add retention progress bar
                </Label>
                {presets.llm_configured && (
                  <Label className={toggle}>
                    <Switch checked={!!value.use_ai} onCheckedChange={(v) => set("use_ai", v)} />
                    <span className="flex items-center gap-1"><Sparkles className="size-3.5 text-primary" /> Enhance hooks & scores with AI</span>
                  </Label>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <div>
                  <label htmlFor="speech-lang" className="mb-1 block text-xs font-medium">Spoken language</label>
                  <select
                    id="speech-lang"
                    value={value.language ?? ""}
                    onChange={(e) => set("language", e.target.value || null)}
                    className={cn(SELECT, "w-full")}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <div>
                    <label htmlFor="wm-text" className="mb-1 block text-xs font-medium">Watermark handle (optional)</label>
                    <Input
                      id="wm-text"
                      value={value.watermark_text ?? ""}
                      onChange={(e) => set("watermark_text", e.target.value)}
                      placeholder="@yourhandle"
                      maxLength={60}
                      className="h-9 text-xs pointer-coarse:h-11 pointer-coarse:text-base"
                    />
                  </div>
                  <div>
                    <label htmlFor="wm-pos" className="mb-1 block text-xs font-medium">Corner</label>
                    <select
                      id="wm-pos"
                      value={value.watermark_position ?? "bottom_right"}
                      onChange={(e) => set("watermark_position", e.target.value as WatermarkPosition)}
                      className={SELECT}
                    >
                      {WM_POSITIONS.map((p) => (
                        <option key={p.key} value={p.key}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
