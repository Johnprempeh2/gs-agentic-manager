import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { api } from "../../api/client";
import { formatDateTime } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type MemberActivityEntry = {
  id: string;
  at: string;
  type: "action" | "decision" | "escalation" | "comment" | "run" | "chat" | "sign_in";
  title: string;
  detail: string | null;
  entityType: string | null;
  entityId: string | null;
};

export const MEMBER_ACTIVITY_TYPE_LABELS: Record<MemberActivityEntry["type"], string> = {
  action: "Actions",
  decision: "Decisions",
  escalation: "Escalations",
  comment: "Comments",
  run: "Agent runs",
  chat: "Chats started",
  sign_in: "Sign-ins",
};

export function memberActivityQuery(input: { from?: string; to?: string; types: string[] }) {
  const params = new URLSearchParams();
  // Dates are whole days in the viewer's time: from the start of `from` to the end of `to`.
  if (input.from) params.set("from", new Date(`${input.from}T00:00:00`).toISOString());
  if (input.to) params.set("to", new Date(`${input.to}T23:59:59.999`).toISOString());
  if (input.types.length) params.set("types", input.types.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * One member's trail for the owner (Ben's access, Nov 2026): actions,
 * decisions, escalations, comments, agent runs and chats they started
 * (titles only) and their sign-ins. Read-only, filtered by date and type.
 */
export function MemberActivityDialog({
  companyId,
  member,
  open,
  onOpenChange,
}: {
  companyId: string;
  member: { userId: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const query = memberActivityQuery({ from, to, types });
  const trail = useQuery({
    queryKey: ["access", "member-activity", companyId, member?.userId ?? "", query],
    queryFn: () => api.get<{ entries: MemberActivityEntry[] }>(
      `/companies/${companyId}/members/${encodeURIComponent(member!.userId)}/activity${query}`,
    ),
    enabled: open && !!member,
  });
  const toggle = (type: string) =>
    setTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{member?.name ?? "Member"}: activity</DialogTitle>
          <DialogDescription>
            Everything they did here, newest first. Chats show titles only.{" "}
            {member ? (
              <Link to={`/desk?member=${encodeURIComponent(member.userId)}`} className="underline underline-offset-2">
                View {member.name}'s Desk
              </Link>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="space-y-1">
            <span className="block text-muted-foreground">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Types">
            {Object.entries(MEMBER_ACTIVITY_TYPE_LABELS).map(([type, label]) => (
              <Button
                key={type}
                type="button"
                size="xs"
                variant={types.includes(type) ? "default" : "outline"}
                aria-pressed={types.includes(type)}
                onClick={() => toggle(type)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="max-h-(--sz-member-activity-max) overflow-y-auto rounded-lg border border-border" data-member-activity>
          {trail.isLoading ? <p className="p-3 text-sm text-muted-foreground">Loading…</p> : null}
          {trail.error ? <p className="p-3 text-sm text-destructive" role="alert">{(trail.error as Error).message}</p> : null}
          {trail.data && trail.data.entries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Nothing in this range.</p>
          ) : null}
          <ul className="divide-y divide-border">
            {(trail.data?.entries ?? []).map((entry) => (
              <li key={entry.id} className="grid gap-x-3 px-3 py-2 text-sm sm:grid-cols-(--gtc-member-activity)">
                <span className="text-muted-foreground">{formatDateTime(entry.at)}</span>
                <span className="font-medium">{MEMBER_ACTIVITY_TYPE_LABELS[entry.type]}</span>
                <span className="min-w-0">
                  <span className="block truncate">{entry.title}</span>
                  {entry.detail ? <span className="block truncate text-muted-foreground">{entry.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
