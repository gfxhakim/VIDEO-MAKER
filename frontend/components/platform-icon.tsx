import { cn } from "@/lib/utils";
import type { Platform } from "@/lib/api";

// Simple, brand-neutral marks (letters on the platform's signature color).
const STYLE: Record<Platform, { label: string; cls: string; letter: string }> = {
  youtube: { label: "YouTube Shorts", cls: "bg-red-600", letter: "YT" },
  tiktok: { label: "TikTok", cls: "bg-zinc-900 ring-1 ring-cyan-400/60", letter: "TT" },
  instagram: { label: "Instagram Reels", cls: "bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600", letter: "IG" },
  facebook: { label: "Facebook Reels", cls: "bg-blue-600", letter: "FB" },
};

export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const s = STYLE[platform];
  return (
    <span title={s?.label} className={cn("grid size-6 shrink-0 place-items-center rounded-md text-[9px] font-bold text-white", s?.cls, className)}>
      {s?.letter ?? "?"}
    </span>
  );
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube Shorts",
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
};
