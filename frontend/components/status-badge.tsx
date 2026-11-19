import { Badge } from "@/components/ui/badge";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAP = {
  draft: ["secondary", "Draft"],
  queued: ["warning", "Waiting"],
  processing: ["warning", "Working"],
  done: ["success", "Ready"],
  failed: ["destructive", "Failed"],
} as const;

export function StatusBadge({ status, className }: { status: Project["status"]; className?: string }) {
  // an unknown status from a newer server still renders, as plain text
  const [variant, label] = MAP[status] ?? (["secondary", String(status || "Unknown")] as const);
  const live = status === "queued" || status === "processing";
  return (
    <Badge variant={variant} className={cn("capitalize", className)}>
      {live && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
      {label}
    </Badge>
  );
}
