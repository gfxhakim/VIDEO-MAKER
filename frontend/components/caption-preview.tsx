"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CaptionStyle } from "@/lib/api";

const FONT_VARS: Record<string, string> = {
  Montserrat: "var(--font-montserrat)",
  Anton: "var(--font-anton)",
  "Bebas Neue": "var(--font-bebas)",
  "DM Serif Display": "var(--font-dmserif)",
  Poppins: "var(--font-poppins)",
};

const SAMPLE = ["this", "changed", "my", "life", "$10,000", "in", "30", "days"];
const KEYWORDS = new Set(["changed", "$10,000", "30"]);

/** `n` preset pixels as an em length of the caption font, so strokes, shadows and gaps scale with the text. */
const em = (n: number, size: number) => `${(n / size).toFixed(4)}em`;

/**
 * CSS approximation of an ASS caption preset, animated word by word.
 *
 * It fills its parent, and the parent must be a size container with a real width and height
 * (`@container-[size]` plus an aspect ratio or a height). The text is sized in container units,
 * so it grows and shrinks with the box: `frame` is how many pixels of the 1080px wide video the
 * box width stands for (smaller = more zoomed in). After layout, anything that still does not
 * fit (an unknown preset, a late font) is scaled down, so the text can never leave the box.
 */
export function CaptionPreview({ style, frame = 830, animate = true }: { style: CaptionStyle; frame?: number; animate?: boolean }) {
  const [i, setI] = useState(1);
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((v) => (v + 1) % SAMPLE.length), 520);
    return () => clearInterval(t);
  }, [animate]);

  // Safety net: shrink the text when it is wider or taller than the box.
  const fit = useCallback(() => {
    const b = box.current;
    const t = text.current;
    const words = t?.firstElementChild as HTMLElement | null | undefined; // its layout size ignores the scale below
    if (!b || !t || !words) return;
    const cs = getComputedStyle(b);
    const w = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w <= 0 || h <= 0 || !words.offsetWidth || !words.offsetHeight) return;
    const k = Math.min(1, w / words.offsetWidth, h / words.offsetHeight);
    t.style.transform = k < 0.995 ? `scale(${k.toFixed(3)})` : "";
  }, []);
  useLayoutEffect(fit, [fit, i, style, frame]); // every new word
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(fit); // the box changed size
    ro.observe(box.current);
    const fonts = document.fonts; // the caption font arrived
    fonts?.addEventListener?.("loadingdone", fit);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener?.("loadingdone", fit);
    };
  }, [fit]);

  const size = style.size > 0 ? style.size : 90;
  const fmt = (w: string) => (style.uppercase ? w.toUpperCase() : w);
  const cycle = style.accent_cycle?.length ? style.accent_cycle : [style.accent];
  const shadow = [
    style.shadow ? `${em(style.shadow, size)} ${em(style.shadow, size)} 0 rgba(0,0,0,.65)` : "",
    style.glow ? `0 0 ${em(style.glow * 1.2, size)} currentColor, 0 0 ${em(style.glow * 2.4, size)} currentColor` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const base: React.CSSProperties = {
    fontFamily: FONT_VARS[style.font] ?? "inherit",
    fontWeight: style.weight,
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: `${((size / frame) * 100).toFixed(2)}cqw`,
    lineHeight: 1.1,
    letterSpacing: style.spacing ? em(style.spacing, size) : undefined,
    WebkitTextStroke: style.outline ? `${em(style.outline, size)} ${style.outline_color}` : undefined,
    paintOrder: "stroke fill",
    textShadow: shadow || undefined,
  };

  // the presets say how many words share the screen; older ones do not, so fall back to three
  const extra = style as CaptionStyle & { words_per_chunk?: number; lead_size?: number };
  const per = Math.min(4, Math.max(2, Math.round(extra.words_per_chunk ?? 3)));
  const start = Math.floor(i / per) * per;
  const chunk = SAMPLE.slice(start, start + per);

  let body: React.ReactNode;
  if (style.mode === "word") {
    const w = SAMPLE[i];
    const color = KEYWORDS.has(w) || style.glow ? cycle[i % cycle.length] : style.primary;
    body = (
      <span key={i} className="inline-block animate-in whitespace-nowrap duration-150 zoom-in-110" style={{ color }}>
        {fmt(w)}
      </span>
    );
  } else if (style.mode === "stack") {
    const lead = extra.lead_size && extra.lead_size > 0 ? extra.lead_size / size : 0.45;
    body = (
      <span className="flex flex-col items-center">
        <span className="text-center" style={{ fontSize: `${lead.toFixed(3)}em`, color: style.primary, fontStyle: "normal", fontWeight: 700 }}>
          {chunk.slice(0, -1).map(fmt).join(" ")}
        </span>
        <span key={i} className="animate-in whitespace-nowrap duration-150 zoom-in-110" style={{ color: cycle[(start / per) % cycle.length] }}>
          {fmt(chunk[chunk.length - 1])}
        </span>
      </span>
    );
  } else {
    body = (
      <span className="flex flex-wrap justify-center" style={{ columnGap: "0.25em" }}>
        {chunk.map((w, k) => {
          const active = start + k === i;
          const color = active ? style.highlight : KEYWORDS.has(w) ? style.accent : style.primary;
          return (
            <span key={k} className={active ? "inline-block animate-in whitespace-nowrap duration-150 zoom-in-110" : "inline-block whitespace-nowrap"} style={{ color }}>
              {fmt(w)}
            </span>
          );
        })}
      </span>
    );
  }

  return (
    <span ref={box} aria-hidden className="block size-full overflow-hidden px-[5cqw] py-[3cqw] select-none">
      {/* Exactly as big as the room inside the box. The words sit in its middle; when they are too big they
          stick out evenly on every side, so scaling this element down around its centre brings them back in. */}
      <span ref={text} data-caption-text className="flex size-full items-center justify-center text-center" style={base}>
        {body}
      </span>
    </span>
  );
}
