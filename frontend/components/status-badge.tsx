import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const MAP: Record<string, readonly ["secondary" | "warning" | "success" | "destructive", string]> = {
  draft: ["secondary", "Draft"],
  queued: ["warning", "Waiting"],
  processing: ["warning", "Working"],
  running: ["warning", "Running"],
  done: ["success", "Ready"],
  failed: ["destructive", "Failed"],
  cancelled: ["secondary", "Cancelled"],
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const [variant, label] = MAP[status] ?? (["secondary", String(status || "Unknown")] as const);
  const live = status === "queued" || status === "processing" || status === "running";
  return (
    <Badge variant={variant} className={cn("capitalize", className)}>
      {live && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
      {label}
    </Badge>
  );
}
