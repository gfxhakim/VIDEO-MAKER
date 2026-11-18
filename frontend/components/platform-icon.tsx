import { cn } from "@/lib/utils";
import type { Platform } from "@/lib/api";

// Simple, brand-neutral marks (letters on each platform's signature color).
const STYLE: Record<Platform, { label: string; cls: string; letter: string }> = {
  tiktok: { label: "TikTok", cls: "bg-zinc-950 ring-1 ring-cyan-400/60", letter: "TT" },
  instagram: { label: "Instagram Reels", cls: "bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600", letter: "IG" },
  youtube: { label: "YouTube Shorts", cls: "bg-red-600", letter: "YT" },
  facebook: { label: "Facebook Reels", cls: "bg-blue-600", letter: "FB" },
};

export const PLATFORMS: Platform[] = ["tiktok", "instagram", "youtube", "facebook"];

export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const s = STYLE[platform];
  return (
    <span
      title={s?.label}
      className={cn("grid size-6 shrink-0 place-items-center rounded-md text-[0.5625rem] leading-none font-bold text-white select-none", s?.cls, className)}
    >
      {s?.letter ?? "?"}
    </span>
  );
}

/** Full product name, for sentences ("Marked as posted on YouTube Shorts"). */
export const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube Shorts",
  facebook: "Facebook",
};

/** One word, for tight spots like the platform picker on a phone. */
export const PLATFORM_SHORT: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  facebook: "Facebook",
};
