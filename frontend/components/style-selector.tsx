"use client";

import useSWR from "swr";
import { Check, Film, Gamepad2, Mic2, ScanFace, Square, Type, UserRound } from "lucide-react";
import { CaptionPreview } from "@/components/caption-preview";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { fetcher, type GenerationSettings, type MusicTrack, type Presets } from "@/lib/api";
import { cn } from "@/lib/utils";

const LAYOUT_ICON: Record<string, React.ElementType> = {
  face_track: ScanFace,
  face_static: UserRound,
  split_faces: Mic2,
  gameplay_facecam: Gamepad2,
  blur_fill: Film,
  center: Square,
};

/** Small 9:16 diagram of how each layout arranges the frame. */
function LayoutDiagram({ layout }: { layout: string }) {
  const box = "absolute rounded-[3px]";
  return (
    <div className="relative h-24 w-[54px] shrink-0 overflow-hidden rounded-md border bg-muted">
      {layout === "split_faces" && (
        <>
          <div className={cn(box, "inset-x-1 top-1 h-[44%] bg-primary/50")} />
          <div className={cn(box, "inset-x-1 bottom-1 h-[44%] bg-fuchsia-400/50")} />
        </>
      )}
      {layout === "gameplay_facecam" && (
        <>
          <div className={cn(box, "inset-x-1 top-1 h-[52%] bg-sky-400/50")} />
          <div className={cn(box, "inset-x-1 bottom-1 h-[38%] bg-primary/50")} />
        </>
      )}
      {layout === "blur_fill" && (
        <>
          <div className="absolute inset-0 bg-gradient-to-b from-zinc-600/40 to-zinc-800/40 blur-[2px]" />
          <div className={cn(box, "inset-x-2 top-3 h-2.5 bg-white")} />
          <div className={cn(box, "inset-x-0 top-[36%] h-[28%] bg-primary/60")} />
        </>
      )}
      {["face_track", "face_static", "center"].includes(layout) && (
        <>
          <div className={cn(box, "inset-1 bg-primary/30")} />
          <div className="absolute top-[28%] left-1/2 size-4 -translate-x-1/2 rounded-full bg-primary/80" />
          {layout === "face_track" && <div className="absolute top-[22%] left-1/2 size-7 -translate-x-1/2 rounded-full border border-dashed border-white/70" />}
        </>
      )}
    </div>
  );
}

export function StyleSelector({ value, onChange }: { value: GenerationSettings; onChange: (v: GenerationSettings) => void }) {
  const { data: presets } = useSWR<Presets>("/api/presets", fetcher);
  const { data: music } = useSWR<MusicTrack[]>("/api/music", fetcher);
  const set = <K extends keyof GenerationSettings>(k: K, v: GenerationSettings[K]) => onChange({ ...value, [k]: v });

  if (!presets) return <div className="py-10 text-center text-sm text-muted-foreground">Loading styles…</div>;

  return (
    <div className="flex flex-col gap-7">
      {/* 1. Editing style */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">1. Editing style</h3>
        <p className="mb-3 text-xs text-muted-foreground">How the 16:9 source is reframed into a vertical video.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.editing_styles.map((s) => {
            const Icon = LAYOUT_ICON[s.layout] ?? Square;
            const on = value.editing_style === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => set("editing_style", s.key)}
                className={cn(
                  "relative flex gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60",
                  on && "border-primary bg-primary/10 ring-1 ring-primary",
                )}
              >
                <LayoutDiagram layout={s.layout} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="size-4 text-primary" /> {s.name}
                  </div>
                  <p className="mt-1 text-xs leading-snug text-muted-foreground">{s.description}</p>
                </div>
                {on && <Check className="absolute top-2 right-2 size-4 text-primary" />}
              </button>
            );
          })}
        </div>
      </section>

      {/* 2. Caption style */}
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Type className="size-4" /> 2. Caption style
        </h3>
        <p className="mb-3 text-xs text-muted-foreground">Word-level kinetic captions. Previews animate like the final render.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {presets.caption_styles.map((c) => {
            const on = value.caption_style === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => set("caption_style", c.key)}
                className={cn("overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/60", on && "border-primary ring-1 ring-primary")}
              >
                <div className="grid h-24 place-items-center bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-900 px-2">
                  <CaptionPreview style={c} animate={on} />
                </div>
                <div className="p-2">
                  <div className="truncate text-xs font-medium">{c.name}</div>
                  <div className="text-[10px] text-muted-foreground capitalize">{c.mode === "chunk" ? "phrase + highlight" : c.mode === "stack" ? "lead + keyword" : "word by word"}</div>
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => set("caption_style", "none")}
            className={cn("grid h-full min-h-32 place-items-center rounded-lg border text-xs text-muted-foreground hover:border-primary/60", value.caption_style === "none" && "border-primary ring-1 ring-primary")}
          >
            No captions
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
          <Label className="font-normal">
            <Switch checked={value.auto_emoji} onCheckedChange={(v) => set("auto_emoji", v)} /> Auto emoji
          </Label>
          <Label className="font-normal">
            <Switch checked={value.hook_title} onCheckedChange={(v) => set("hook_title", v)} /> Hook title card on every clip
          </Label>
        </div>
      </section>

      {/* 3. Format + length */}
      <section className="grid gap-5 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">3. Aspect ratio</h3>
          <div className="flex gap-2">
            {presets.aspect_ratios.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => set("aspect_ratio", a.key)}
                className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", value.aspect_ratio === a.key && "border-primary bg-primary/10")}
              >
                <span className="inline-block rounded-[2px] border-2 border-current" style={{ width: (a.width / a.height) * 18, height: 18 }} />
                {a.key}
                {a.key === "9:16" && <Badge variant="secondary">default</Badge>}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Clip length <span className="font-normal text-muted-foreground">{value.min_duration}s – {value.max_duration}s</span>
          </h3>
          <Slider
            min={5}
            max={120}
            step={5}
            value={[value.min_duration, value.max_duration]}
            onValueChange={([a, b]) => onChange({ ...value, min_duration: a, max_duration: Math.max(b, a + 5) })}
          />
          <p className="text-xs text-muted-foreground">15–60s keeps retention high on every platform.</p>
        </div>
      </section>

      {/* 4. Music */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">4. Background music</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Pick several songs: they rotate across clips. The drop is lined up with each clip&apos;s hook and the music ducks under speech.
        </p>
        {music?.length ? (
          <div className="flex flex-wrap gap-2">
            {music.map((m) => {
              const on = value.music_track_ids.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => set("music_track_ids", on ? value.music_track_ids.filter((x) => x !== m.id) : [...value.music_track_ids, m.id])}
                  className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs", on && "border-primary bg-primary/15")}
                >
                  {on && <Check className="size-3" />} {m.name}
                  {m.bpm ? <span className="text-muted-foreground">{Math.round(m.bpm)} bpm</span> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No songs yet. Add some in the <a href="/music" className="text-primary underline">Music library</a> (optional).
          </p>
        )}
        {value.music_track_ids.length > 0 && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="mb-2 font-normal">Music volume {Math.round(value.music_volume * 100)}%</Label>
              <Slider min={0} max={60} step={1} value={[Math.round(value.music_volume * 100)]} onValueChange={([v]) => set("music_volume", v / 100)} />
            </div>
            <div className="flex flex-col gap-3">
              <Label className="font-normal">
                <Switch checked={value.ducking} onCheckedChange={(v) => set("ducking", v)} /> Duck music when someone speaks
              </Label>
              <Label className="font-normal">
                <Switch checked={value.match_drop_to_hook} onCheckedChange={(v) => set("match_drop_to_hook", v)} /> Sync the beat drop to the hook
              </Label>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
