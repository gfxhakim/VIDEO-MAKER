import { Badge } from "@/components/ui/badge";
import type { Project } from "@/lib/api";

export function StatusBadge({ status }: { status: Project["status"] }) {
  const map = {
    draft: ["secondary", "Draft"],
    queued: ["warning", "Queued"],
    processing: ["warning", "Processing"],
    done: ["success", "Ready"],
    failed: ["destructive", "Failed"],
  } as const;
  const [variant, label] = map[status] ?? ["secondary", status];
  return <Badge variant={variant}>{label}</Badge>;
}
