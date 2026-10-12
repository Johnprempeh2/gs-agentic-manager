import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EmailEndpointSummary, StrategyBoardEmail, StrategyBoardEmailKind } from "@greatstone/shared";
import { emailApi } from "@/api/email";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export const BOARD_EMAIL_KIND_LABEL: Record<StrategyBoardEmailKind, string> = {
  meeting_reminder: "Meeting reminder",
  slippage_alert: "Slippage alert",
  why_request: "\"Why?\" request",
};

/** One line for the recent board emails list. */
export function boardEmailLine(email: StrategyBoardEmail): string {
  const what = BOARD_EMAIL_KIND_LABEL[email.kind];
  const when = new Date(email.createdAt).toISOString().slice(0, 10);
  const outcome = email.status === "failed" ? `not sent: ${email.lastError ?? "unknown error"}` : "sent";
  return `${when} · ${what} to ${email.recipientEmail} · ${outcome}`;
}

/** Inboxes that may send board email: this company's, not archived. */
export function secretaryInboxOptions(inboxes: readonly EmailEndpointSummary[]): EmailEndpointSummary[] {
  return inboxes.filter((inbox) => inbox.status !== "archived");
}

/**
 * Board email (GRE-1187), for company owners: the next board meeting, how
 * early owners are reminded, and the inbox the board secretary sends from.
 */
export function BoardEmailCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const settings = useQuery({
    queryKey: queryKeys.strategyBoard.settings(companyId),
    queryFn: () => strategyBoardApi.settings(companyId),
  });
  const inboxes = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
  });
  const emails = useQuery({
    queryKey: queryKeys.strategyBoard.emails(companyId),
    queryFn: () => strategyBoardApi.emails(companyId),
  });
  const [inboxId, setInboxId] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [leadDays, setLeadDays] = useState("7");
  useEffect(() => {
    if (!settings.data) return;
    setInboxId(settings.data.secretaryEndpointId ?? "");
    setMeetingDate(settings.data.nextMeetingDate ?? "");
    setLeadDays(String(settings.data.reminderLeadDays));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      strategyBoardApi.updateSettings(companyId, {
        secretaryEndpointId: inboxId || null,
        nextMeetingDate: meetingDate || null,
        reminderLeadDays: Math.max(0, Math.min(60, Number.parseInt(leadDays, 10) || 0)),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.strategyBoard.settings(companyId), next);
      pushToast({ title: "Board email saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Board email not saved", body: err.message, tone: "error" }),
  });

  if (settings.isLoading || inboxes.isLoading) return <p className="text-sm text-muted-foreground">Loading board email…</p>;
  if (settings.error) return <p className="text-sm text-status-danger">Could not load board email: {(settings.error as Error).message}</p>;
  const options = secretaryInboxOptions(inboxes.data ?? []);
  const recent = (emails.data ?? []).slice(0, 5);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The board secretary emails each KPI owner before the board meeting, the chair when a KPI turns red, and the owner
        when the board asks "Why?". An instance admin chooses which of these go by email.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="board-secretary-inbox">Board secretary inbox</Label>
          <NativeSelect id="board-secretary-inbox" value={inboxId} onChange={(event) => setInboxId(event.target.value)}>
            <option value="">No board email: alerts stay in the app</option>
            {options.map((inbox) => (
              <option key={inbox.id} value={inbox.id}>
                {inbox.address ?? inbox.id}
                {inbox.status !== "active" ? ` (${inbox.status})` : ""}
              </option>
            ))}
          </NativeSelect>
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">No email inbox yet. Connect an AgentMail inbox in Apps first.</p>
          ) : null}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="board-next-meeting">Next board meeting</Label>
          <Input id="board-next-meeting" type="date" value={meetingDate} onChange={(event) => setMeetingDate(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="board-lead-days">Remind owners (days before)</Label>
          <Input
            id="board-lead-days"
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            value={leadDays}
            onChange={(event) => setLeadDays(event.target.value)}
          />
        </div>
      </div>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save board email"}
      </Button>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Recent board emails</p>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No board email sent yet.</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((email) => (
              <li key={email.id} className={`break-words text-sm ${email.status === "failed" ? "text-status-danger" : ""}`}>
                {boardEmailLine(email)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
