import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hourglass, Loader2 } from "lucide-react";
import { decisionsFeedApi } from "../../api/decisionsFeed";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { formatDate } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { IconTip } from "../ui/tooltip";
import { returnAtFromDateInput } from "./NotNowButton";

function tomorrowInputValue(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface WaitingOutsideButtonProps {
  companyId: string;
  issueId: string;
  issueLabel?: string | null;
  compact?: boolean;
  onTabled?: () => void;
}

/**
 * "Waiting on someone outside" (Tidy desk): asks who and when, then tables the
 * task until that date with the note on the thread. It comes back by itself.
 */
export function WaitingOutsideButton({ companyId, issueId, issueLabel, compact, onTabled }: WaitingOutsideButtonProps) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState("");
  const [date, setDate] = useState("");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const returnAt = returnAtFromDateInput(date);
  const ready = who.trim().length > 0 && returnAt !== null;

  const wait = useMutation({
    mutationFn: () => decisionsFeedApi.table(issueId, returnAt, who.trim()),
    onSuccess: () => {
      setOpen(false);
      setWho("");
      setDate("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
      pushToast({
        id: `waiting-outside-${issueId}`,
        title: "Waiting on someone outside",
        body: `${issueLabel ?? "The task"} comes back on ${returnAt ? formatDate(returnAt) : "its date"}.`,
        tone: "info",
        ttlMs: 5000,
      });
      onTabled?.();
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {(() => {
          const button = (
            <Button
              type="button"
              variant="ghost"
              size={compact ? "icon-xs" : "xs"}
              aria-label={`Waiting on someone outside: ${issueLabel ?? "this task"}`}
              data-waiting-outside={issueId}
              className="text-muted-foreground hover:text-foreground"
            >
              <Hourglass aria-hidden />
              {compact ? null : "Waiting outside"}
            </Button>
          );
          return <IconTip label="Waiting on someone outside" off={!compact}>{button}</IconTip>;
        })()}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) wait.mutate();
          }}
        >
          <div>
            <p className="text-sm font-medium">Waiting on someone outside</p>
            <p className="text-xs text-muted-foreground">
              The task leaves your desk and Decisions, and comes back on the date.
            </p>
          </div>
          <label className="block space-y-1 text-xs font-medium">
            <span>Who are you waiting on?</span>
            <Input value={who} maxLength={500} onChange={(event) => setWho(event.target.value)} />
          </label>
          <label className="block space-y-1 text-xs font-medium">
            <span>Bring back on</span>
            <Input type="date" min={tomorrowInputValue()} value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          {wait.error ? (
            <p className="text-xs text-destructive" role="alert">
              {(wait.error as Error).message}
            </p>
          ) : null}
          <div className="flex justify-between gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!ready || wait.isPending}>
              {wait.isPending ? <Loader2 className="animate-spin" /> : null}
              Set aside until then
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
