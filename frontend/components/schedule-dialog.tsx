"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { CalendarClock, Loader2, Rocket } from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, fetcher, type Account } from "@/lib/api";
import { cn } from "@/lib/utils";

function localInputValue(d: Date) {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleDialog({ open, onOpenChange, clipIds, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; clipIds: number[]; onDone?: () => void }) {
  const { data: accounts } = useSWR<Account[]>(open ? "/api/accounts" : null, fetcher);
  const enabled = useMemo(() => (accounts ?? []).filter((a) => a.enabled && a.connected), [accounts]);
  const [picked, setPicked] = useState<number[] | null>(null);
  const chosen = picked ?? enabled.map((a) => a.id);
  const [now, setNow] = useState(false);
  const [start, setStart] = useState(() => localInputValue(new Date(Date.now() + 10 * 60000)));
  const [interval, setInterval] = useState(90);
  const [offset, setOffset] = useState(7);
  const [jitter, setJitter] = useState(6);
  const [privacy, setPrivacy] = useState("public");
  const [busy, setBusy] = useState(false);

  const total = clipIds.length * chosen.length;

  async function submit() {
    setBusy(true);
    try {
      const jobs = await api.schedule({
        clip_ids: clipIds,
        account_ids: chosen,
        start_at: now ? null : new Date(start).toISOString(),
        interval_minutes: interval,
        account_offset_minutes: offset,
        jitter_minutes: jitter,
        privacy,
        publish_now: now,
      });
      toast.success(`${jobs.length} posts queued`, { description: now ? "Publishing now (still respecting per-account limits)." : "See them in the Schedule queue." });
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error("Scheduling failed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="size-5 text-primary" /> Publish {clipIds.length} clip{clipIds.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>Posts are staggered per account and per platform to stay inside rate limits and avoid spam flags.</DialogDescription>
        </DialogHeader>

        <div>
          <Label className="mb-2">Accounts</Label>
          {!accounts ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : enabled.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No connected accounts. <Link href="/publish" className="text-primary underline">Connect accounts in the Publish Hub</Link>.
            </p>
          ) : (
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-1">
              {enabled.map((a) => (
                <label key={a.id} className={cn("flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-accent", chosen.includes(a.id) && "bg-accent/60")}>
                  <Checkbox checked={chosen.includes(a.id)} onCheckedChange={(v) => setPicked(v ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
                  <PlatformIcon platform={a.platform} />
                  <span className="truncate text-sm">{a.display_name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">≤{a.daily_limit}/day · {a.min_interval_minutes}m gap</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <Label className="font-normal"><Switch checked={now} onCheckedChange={setNow} /> Publish now instead of scheduling</Label>

        {!now && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="mb-1.5 text-xs">First post at</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 text-xs">Minutes between clips (same account)</Label>
              <Input type="number" min={0} value={interval} onChange={(e) => setInterval(+e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 text-xs">Stagger between accounts (min)</Label>
              <Input type="number" min={0} value={offset} onChange={(e) => setOffset(+e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 text-xs">Random jitter ± (min)</Label>
              <Input type="number" min={0} value={jitter} onChange={(e) => setJitter(+e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 text-xs">Visibility</Label>
              <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">
                <option value="public">Public</option>
                <option value="unlisted">Unlisted / friends</option>
                <option value="private">Private</option>
              </select>
            </div>
          </div>
        )}

        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">{total} post{total === 1 ? "" : "s"} total</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || total === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <Rocket />} {now ? "Publish now" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
