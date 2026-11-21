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
const SAMPLE_EMOJI = ["⚡", "🔥", "🔥", "❤️‍🔥", "💸", "💸", "📈", "🚀"];

const em = (n: number, size: number) => `${(n / size).toFixed(4)}em`;

export function CaptionPreview({
  style,
  frame = 830,
  animate = true,
  showEmoji = false,
  colorOverride,
}: {
  style: CaptionStyle;
  frame?: number;
  animate?: boolean;
  showEmoji?: boolean;
  colorOverride?: string | null;
}) {
  const [i, setI] = useState(1);
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((v) => (v + 1) % SAMPLE.length), 520);
    return () => clearInterval(t);
  }, [animate]);

  const fit = useCallback(() => {
    const b = box.current;
    const t = text.current;
    const words = t?.firstElementChild as HTMLElement | null | undefined;
    if (!b || !t || !words) return;
    const cs = getComputedStyle(b);
    const w = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w <= 0 || h <= 0 || !words.offsetWidth || !words.offsetHeight) return;
    const k = Math.min(1, w / words.offsetWidth, h / words.offsetHeight);
    t.style.transform = k < 0.995 ? `scale(${k.toFixed(3)})` : "";
  }, []);
  useLayoutEffect(fit, [fit, i, style, frame, colorOverride]);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);
    const fonts = document.fonts;
    fonts?.addEventListener?.("loadingdone", fit);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener?.("loadingdone", fit);
    };
  }, [fit]);

  const size = style.size > 0 ? style.size : 90;
  const fmt = (w: string) => (style.uppercase ? w.toUpperCase() : w);
  const custom = colorOverride?.trim() || "";
  const hiColor = custom || style.highlight;
  const acColor = custom || style.accent;
  const cycle = custom ? [custom, "#FFFFFF", custom] : style.accent_cycle?.length ? style.accent_cycle : [style.accent];
  const isBoxed = style.mode === "boxed";
  const shadow = [
    style.shadow ? `${em(style.shadow, size)} ${em(style.shadow, size)} 0 rgba(0,0,0,.75)` : "0 0.06em 0.14em rgba(0,0,0,.6)",
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
    WebkitTextStroke: !isBoxed && style.outline ? `${em(style.outline, size)} ${style.outline_color}` : undefined,
    paintOrder: "stroke fill",
    textShadow: shadow || undefined,
  };

  const extra = style as CaptionStyle & { words_per_chunk?: number; lead_size?: number };
  const per = Math.min(4, Math.max(2, Math.round(extra.words_per_chunk ?? 3)));
  const start = Math.floor(i / per) * per;
  const chunk = SAMPLE.slice(start, start + per);
  const hasKeywordInChunk = chunk.some((w) => KEYWORDS.has(w));
  const emojiChar = SAMPLE_EMOJI[i] ?? "🔥";

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
      <span
        className="flex flex-wrap justify-center rounded-md"
        style={{
          columnGap: "0.25em",
          ...(isBoxed ? { backgroundColor: style.box_color || "rgba(17,17,22,0.88)", padding: "0.14em 0.34em" } : {}),
        }}
      >
        {chunk.map((w, k) => {
          const active = start + k === i;
          const color = active ? hiColor : KEYWORDS.has(w) ? acColor : style.primary;
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
    <span ref={box} aria-hidden className="relative block size-full overflow-hidden px-[5cqw] py-[3cqw] select-none">
      {showEmoji && (hasKeywordInChunk || KEYWORDS.has(SAMPLE[i])) && (
        <span className="absolute top-[6%] left-1/2 -translate-x-1/2 text-[14cqw] leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,.75)]">
          {emojiChar}
        </span>
      )}
      <span ref={text} data-caption-text className="flex size-full items-center justify-center text-center" style={base}>
        {body}
      </span>
    </span>
  );
}
