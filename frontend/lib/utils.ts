import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function fmtDuration(sec?: number | null) {
  if (!finite(sec) || sec < 0) return "–";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}` : `${m}:${s.toString().padStart(2, "0")}`;
}

/** 312 KB, 4.2 MB, 412 MB, 1.94 GB, 12.4 GB (decimal units, like the file manager shows them). */
export function fmtBytes(n: number) {
  if (!finite(n) || n <= 0) return "0 MB";
  if (n >= 1e10) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e9) return `${(Math.floor(n / 1e7) / 100).toFixed(2)} GB`; // floor: never claim more than is there
  if (n >= 1e7) return `${Math.floor(n / 1e6)} MB`;
  if (n >= 1e6) return `${(Math.floor(n / 1e5) / 10).toFixed(1)} MB`; // the first megabytes of a slow upload visibly move
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** 290 KB/s, 1.4 MB/s. Empty string while the speed is unknown. */
export function fmtSpeed(bytesPerSecond: number) {
  if (!finite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1e3))} KB/s`;
}

/** "about 1 h 12 min left", "about 12 min left", "less than a minute left". Empty string while unknown. */
export function fmtEta(sec: number | null | undefined) {
  if (!finite(sec) || sec < 0) return "";
  if (sec < 50) return "less than a minute left";
  let m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `about ${m} min left`;
  if (m >= 180) m = Math.round(m / 5) * 5; // far away: steps of five minutes, so it does not flicker
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h >= 48) return `about ${Math.round(h / 24)} days left`;
  return rest ? `about ${h} h ${rest} min left` : `about ${h} h left`;
}

/** Share of `part` in `whole` as a 0..100 number that is always safe to show and to use as a width. */
export function pctOf(part: number, whole: number) {
  if (!finite(part) || !finite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** "4.2%" under ten percent (so a big upload visibly moves), "37%" above. Rounds down: 100% means done. */
export function fmtPercent(pct: number) {
  if (!finite(pct) || pct <= 0) return "0%";
  const p = Math.min(100, pct);
  return p < 10 ? `${(Math.floor(p * 10) / 10).toFixed(1)}%` : `${Math.floor(p)}%`;
}

/** Splits "holiday video.final.MP4" into ["holiday video.final", ".MP4"], so the name can be
 *  shortened in the middle and the ending stays readable. */
export function splitFileName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 6) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

export function fmtDate(iso: string) {
  // API sends UTC; show it in the viewer's local time
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
