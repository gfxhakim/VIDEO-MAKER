import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtDuration(sec?: number | null) {
  if (sec == null) return "–";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 412 MB, 1.94 GB (decimal units, like the file manager shows them). */
export function fmtBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function fmtSpeed(bytesPerSecond: number) {
  return bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1e3)} KB/s`;
}

export function fmtEta(sec: number | null) {
  if (sec == null) return "working out the time left";
  if (sec < 60) return "less than a minute left";
  const m = Math.round(sec / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

export function fmtDate(iso: string) {
  // API sends UTC; show it in the viewer's local time
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
