"use client";

import { useEffect, useState } from "react";
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

/** CSS approximation of an ASS caption preset, animated word by word. */
export function CaptionPreview({ style, scale = 0.32, animate = true }: { style: CaptionStyle; scale?: number; animate?: boolean }) {
  const [i, setI] = useState(1);
  useEffect(() => {
    if (!animate) return;
    const t = setInterval(() => setI((v) => (v + 1) % SAMPLE.length), 520);
    return () => clearInterval(t);
  }, [animate]);

  const size = style.size * scale;
  const outline = style.outline * scale;
  const fmt = (w: string) => (style.uppercase ? w.toUpperCase() : w);
  const cycle = style.accent_cycle?.length ? style.accent_cycle : [style.accent];
  const shadow = [
    style.shadow ? `${style.shadow * scale}px ${style.shadow * scale}px 0 rgba(0,0,0,.65)` : "",
    style.glow ? `0 0 ${style.glow * scale * 1.2}px currentColor, 0 0 ${style.glow * scale * 2.4}px currentColor` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const base: React.CSSProperties = {
    fontFamily: FONT_VARS[style.font] ?? "inherit",
    fontWeight: style.weight,
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: size,
    lineHeight: 1.1,
    letterSpacing: style.spacing ? style.spacing * scale : undefined,
    WebkitTextStroke: outline ? `${outline}px ${style.outline_color}` : undefined,
    paintOrder: "stroke fill",
    textShadow: shadow || undefined,
  };

  if (style.mode === "word") {
    const w = SAMPLE[i];
    const color = KEYWORDS.has(w) || style.glow ? cycle[i % cycle.length] : style.primary;
    return (
      <span key={i} className="inline-block animate-in zoom-in-110 duration-150" style={{ ...base, color }}>
        {fmt(w)}
      </span>
    );
  }
  const start = Math.floor(i / 3) * 3;
  const chunk = SAMPLE.slice(start, start + 3);
  if (style.mode === "stack") {
    const key = chunk[chunk.length - 1];
    return (
      <span className="flex flex-col items-center" style={base}>
        <span style={{ fontSize: size * 0.45, color: style.primary, fontStyle: "normal", fontWeight: 700 }}>
          {chunk.slice(0, -1).map(fmt).join(" ")}
        </span>
        <span key={i} className="animate-in zoom-in-110 duration-150" style={{ color: cycle[start % cycle.length] }}>
          {fmt(key)}
        </span>
      </span>
    );
  }
  return (
    <span className="text-center" style={base}>
      {chunk.map((w, k) => {
        const active = start + k === i;
        const color = active ? style.highlight : KEYWORDS.has(w) ? style.accent : style.primary;
        return (
          <span key={k} className={active ? "inline-block animate-in zoom-in-110 duration-150" : "inline-block"} style={{ color, marginRight: size * 0.25 }}>
            {fmt(w)}
          </span>
        );
      })}
    </span>
  );
}
