import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2 } from "lucide-react";
import { decisionsFeedApi } from "../../api/decisionsFeed";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** Return dates are set to 09:00 local time on the chosen day. */
export function returnAtFromDateInput(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 9, 0, 0, 0).toISOString();
}

function dateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
}

export interface NotNowButtonProps {
  companyId: string;
  issueId: string;
  /** Shown in the toast, e.g. "GRE-138". */
  issueLabel?: string | null;
  size?: "xs" | "sm";
  onTabled?: () => void;
}

/**
 * "Not now" (GRE-262/GRE-264): tables the whole task with an optional return
 * date. The task leaves Decisions and Focus and its agents are not woken until
 * it comes back. Replaces the old per-card snooze.
 */
export function NotNowButton({ companyId, issueId, issueLabel, size = "xs", onTabled }: NotNowButtonProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const table = useMutation({
    mutationFn: (returnAt: string | null) => decisionsFeedApi.table(issueId, returnAt),
    onSuccess: (_issue, returnAt) => {
      setOpen(false);
      setDate("");
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      // The task page may key its detail by identifier, so refresh every detail.
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] });
      pushToast({
        id: `not-now-${issueId}`,
        title: "Set aside",
        body: returnAt
          ? `${issueLabel ?? "The task"} comes back on ${new Date(returnAt).toLocaleDateString()}.`
          : `${issueLabel ?? "The task"} waits in Tabled until you bring it back.`,
        tone: "info",
        ttlMs: 5000,
      });
      onTabled?.();
    },
  });

  const minDate = daysFromToday(1);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size={size} aria-label="Not now">
          <Clock />
          Not now
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <div>
          <p className="text-sm font-medium">Set this task aside</p>
          <p className="text-xs text-muted-foreground">
            It leaves Decisions and Focus. No agent works on it until it comes back.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="xs" variant="outline" onClick={() => setDate(daysFromToday(1))}>
            Tomorrow
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setDate(daysFromToday(7))}>
            Next week
          </Button>
        </div>
        <label className="block space-y-1 text-xs font-medium">
          <span>Bring back on (optional)</span>
          <Input type="date" min={minDate} value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        {table.error ? (
          <p className="text-xs text-destructive" role="alert">
            {(table.error as Error).message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={table.isPending}
            onClick={() => table.mutate(returnAtFromDateInput(date))}
          >
            {table.isPending ? <Loader2 className="animate-spin" /> : null}
            {date ? "Set aside" : "Set aside until I bring it back"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
