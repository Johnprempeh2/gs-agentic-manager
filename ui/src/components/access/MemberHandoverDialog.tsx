import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  MemberHandoverAction,
  MemberHandoverGroup,
  MemberHandoverItem,
  MemberHandoverOverride,
  MemberHandoverPlan,
} from "@greatstone/shared";
import { accessApi, type CompanyMember } from "@/api/access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

type Step = "successor" | "review" | "confirm" | "done";

const GROUP_LABELS: Record<MemberHandoverGroup, string> = {
  work: "Open work",
  requests: "Questions and requests",
  routines: "Routines and defaults",
  agents: "Agents and AI accounts",
  connections: "Connections",
  access: "Access",
};
const GROUP_ORDER: MemberHandoverGroup[] = ["work", "requests", "routines", "agents", "connections", "access"];

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function memberName(member: Pick<CompanyMember, "principalId" | "user"> | null | undefined) {
  if (!member) return "this person";
  return member.user?.name?.trim() || member.user?.email || member.principalId;
}

/** The select value an override is shown as. "" is the recommendation. */
function overrideValue(override: MemberHandoverOverride | undefined) {
  if (!override) return "";
  if (override.toUserId) return `user:${override.toUserId}`;
  if (override.toAgentId) return `agent:${override.toAgentId}`;
  if (override.action === "use_shared_connection") return `shared:${override.sharedGrantId}`;
  return override.action ?? "";
}

function overrideFromValue(itemRef: string, value: string): MemberHandoverOverride | null {
  if (!value) return null;
  if (value.startsWith("user:")) return { itemRef, toUserId: value.slice(5) };
  if (value.startsWith("agent:")) return { itemRef, toAgentId: value.slice(6) };
  if (value.startsWith("shared:")) return { itemRef, action: "use_shared_connection", sharedGrantId: value.slice(7) };
  return { itemRef, action: value as MemberHandoverOverride["action"] };
}

/**
 * Hand over and remove a person: choose who takes over, review everything
 * that depends on them (with a change per item), confirm, then see the result
 * and the handover task. The server builds the plan; this dialog only shows
 * it and sends the choices back.
 */
export function MemberHandoverDialog({
  companyId,
  member,
  members,
  agents,
  defaultSuccessorUserId,
  canRemoveInstanceAdmin,
  open,
  onOpenChange,
}: {
  companyId: string;
  member: CompanyMember | null;
  members: CompanyMember[];
  agents: Agent[];
  defaultSuccessorUserId: string | null;
  canRemoveInstanceAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [step, setStep] = useState<Step>("successor");
  const [successorUserId, setSuccessorUserId] = useState("");
  const [overrides, setOverrides] = useState<Record<string, MemberHandoverOverride>>({});
  const [removeInstanceAdmin, setRemoveInstanceAdmin] = useState(false);
  const [result, setResult] = useState<MemberHandoverPlan | null>(null);

  const candidates = useMemo(
    () => members.filter((entry) =>
      entry.status === "active" && entry.principalType === "user" && entry.id !== member?.id && entry.principalId !== "local-board"),
    [members, member?.id],
  );
  const assignableAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval"),
    [agents],
  );
  const nameOf = (userId: string) => {
    const found = members.find((entry) => entry.principalId === userId);
    return found ? memberName(found) : userId;
  };

  useEffect(() => {
    if (!open || !member) return;
    setStep("successor");
    setOverrides({});
    setRemoveInstanceAdmin(false);
    setResult(null);
    const fallback = candidates.find((entry) => entry.principalId === defaultSuccessorUserId) ?? candidates[0];
    setSuccessorUserId(fallback?.principalId ?? "");
    // Reset only when the dialog opens for a person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member?.id]);

  const overrideList = Object.values(overrides);
  const planQuery = useQuery({
    queryKey: ["access", "member-handover", companyId, member?.id ?? "", successorUserId, overrideList, removeInstanceAdmin],
    queryFn: () => accessApi.handOverMember(companyId, member!.id, {
      successorUserId,
      overrides: overrideList,
      dryRun: true,
      removeInstanceAdmin,
    }),
    enabled: open && !!member && !!successorUserId && (step === "review" || step === "confirm"),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const plan = planQuery.data;

  const executeMutation = useMutation({
    mutationFn: () => accessApi.handOverMember(companyId, member!.id, {
      successorUserId,
      overrides: overrideList,
      dryRun: false,
      removeInstanceAdmin,
    }),
    onSuccess: async (done) => {
      setResult(done);
      setStep("done");
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(companyId) });
      await queryClient.invalidateQueries({ queryKey: ["access", "company-members-archived", companyId] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
    onError: (error) => {
      pushToast({
        title: "Could not hand over",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const setOverride = (itemRef: string, value: string) => {
    setOverrides((current) => {
      const next = { ...current };
      const override = overrideFromValue(itemRef, value);
      if (override) next[itemRef] = override;
      else delete next[itemRef];
      return next;
    });
  };

  const describeAction = (action: MemberHandoverAction): string => {
    switch (action.type) {
      case "move_to_user": return `To ${nameOf(action.userId)}`;
      case "move_to_agent": return `To ${assignableAgents.find((agent) => agent.id === action.agentId)?.name ?? "an agent"}`;
      case "unassign": return "Leave unassigned";
      case "close": return "Close";
      case "leave": return "Leave as it is";
      case "clear": return "Clear";
      case "keep_ai_setting": return "Keeps its setting: runs on the new responsible person's default account";
      case "use_personal_default": return "Switch to the responsible person's default account";
      case "use_shared_connection": return `Use shared account ${action.name}`;
      case "revoke": return "Revoke";
      case "remove": return "Remove";
      case "end": return "End";
      case "archive": return "Archive";
      case "suspend": return "Suspend";
      case "keep": return "Keep";
    }
  };

  const itemOptions = (item: MemberHandoverItem) => {
    const options: Array<{ value: string; label: string }> = [
      { value: "", label: `Recommended: ${describeAction(item.recommended)}` },
    ];
    if (item.choices.includes("user")) {
      for (const candidate of candidates) {
        options.push({ value: `user:${candidate.principalId}`, label: `To ${memberName(candidate)}` });
      }
    }
    if (item.choices.includes("agent")) {
      for (const agent of assignableAgents) options.push({ value: `agent:${agent.id}`, label: `To agent ${agent.name}` });
    }
    if (item.choices.includes("unassign")) options.push({ value: "unassign", label: "Leave unassigned" });
    if (item.choices.includes("close")) options.push({ value: "close", label: "Close" });
    if (item.choices.includes("clear")) options.push({ value: "clear", label: "Clear" });
    if (item.choices.includes("use_personal_default")) {
      options.push({ value: "use_personal_default", label: "Use the responsible person's default account" });
    }
    if (item.choices.includes("use_shared_connection")) {
      for (const shared of item.sharedAlternatives ?? []) {
        options.push({ value: `shared:${shared.grantId}`, label: `Use shared account ${shared.name}` });
      }
    }
    if (item.choices.includes("leave")) options.push({ value: "leave", label: "Leave as it is" });
    return options;
  };

  const leaving = memberName(member);
  const showsInstanceAdminChoice = Boolean(plan?.items.some((item) => item.kind === "instance_admin" && item.planned.type !== "keep"))
    || removeInstanceAdmin;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {step === "done" ? `${leaving} has been handed over` : `Hand over and remove ${leaving}`}
          </DialogTitle>
          <DialogDescription>
            {step === "successor" && "Step 1 of 3: choose who takes over their work."}
            {step === "review" && "Step 2 of 3: check where each thing goes. Change any item, or keep the recommendation."}
            {step === "confirm" && "Step 3 of 3: confirm. Everything below happens in one go."}
            {step === "done" && "Their work has moved and their access is switched off."}
          </DialogDescription>
        </DialogHeader>

        {step === "successor" && (
          <div className="space-y-3 text-sm">
            <label className="block space-y-2">
              <span className="font-medium">Successor</span>
              <select
                aria-label="Successor"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
                value={successorUserId}
                onChange={(event) => setSuccessorUserId(event.target.value)}
              >
                {candidates.length === 0 ? <option value="">No other active person</option> : null}
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.principalId}>
                    {memberName(candidate)}
                    {candidate.membershipRole ? ` (${candidate.membershipRole})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-muted-foreground">
              Their open tasks, pending questions, routines and agents go to this person by default. You can send
              single items elsewhere on the next step.
            </p>
          </div>
        )}

        {(step === "review" || step === "confirm") && (
          <div className="max-h-(--sz-60vh) space-y-4 overflow-y-auto text-sm">
            {planQuery.isLoading ? (
              <div className="text-muted-foreground">Checking everything that depends on {leaving}...</div>
            ) : planQuery.error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
                {planQuery.error instanceof Error ? planQuery.error.message : "Could not build the handover plan."}
              </div>
            ) : plan ? (
              <>
                {plan.blockers.length > 0 && (
                  <div role="alert" className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
                    <div className="font-medium">Resolve these before handing over</div>
                    <ul className="list-disc space-y-1 pl-5">
                      {plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                    </ul>
                  </div>
                )}
                {step === "review" ? (
                  <>
                    {showsInstanceAdminChoice && (
                      <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={removeInstanceAdmin}
                          disabled={!canRemoveInstanceAdmin}
                          onChange={(event) => setRemoveInstanceAdmin(event.target.checked)}
                        />
                        <span>
                          Also remove their instance admin role (it covers every company on this install).
                          {!canRemoveInstanceAdmin ? " Only an owner can do this." : ""}
                        </span>
                      </label>
                    )}
                    {GROUP_ORDER.map((group) => {
                      const groupItems = plan.items.filter((item) => item.group === group);
                      if (groupItems.length === 0) return null;
                      return (
                        <section key={group} className="space-y-2">
                          <h3 className="font-medium">{GROUP_LABELS[group]}</h3>
                          <div className="rounded-lg border border-border">
                            {groupItems.map((item) => (
                              <HandoverItemRow
                                key={item.ref}
                                item={item}
                                options={item.choices.length > 0 ? itemOptions(item) : null}
                                value={overrideValue(overrides[item.ref])}
                                planned={describeAction(item.planned)}
                                onChange={(value) => setOverride(item.ref, value)}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </>
                ) : (
                  <HandoverSummary plan={plan} successorName={nameOf(successorUserId)} />
                )}
                {plan.warnings.length > 0 && (
                  <div className="space-y-1 text-muted-foreground">
                    <div className="font-medium text-foreground">Worth knowing</div>
                    <ul className="list-disc space-y-1 pl-5">
                      {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3 text-sm">
            <HandoverSummary plan={result} successorName={nameOf(successorUserId)} />
            {result.handoverIssue ? (
              <p>
                {nameOf(successorUserId)} has a task with the full list:{" "}
                <Link
                  to={`/issues/${result.handoverIssue.identifier ?? result.handoverIssue.id}`}
                  className="font-medium underline"
                  onClick={() => onOpenChange(false)}
                >
                  {result.handoverIssue.identifier ? `${result.handoverIssue.identifier} ` : ""}
                  {result.handoverIssue.title}
                </Link>
              </p>
            ) : null}
            <p className="text-muted-foreground">You can restore {leaving}'s access from the member list. Moved work stays where it is.</p>
          </div>
        )}

        <DialogFooter>
          {step === "successor" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStep("review")} disabled={!successorUserId}>Next</Button>
            </>
          )}
          {step === "review" && (
            <>
              <Button variant="outline" onClick={() => setStep("successor")}>Back</Button>
              <Button onClick={() => setStep("confirm")} disabled={!plan || plan.blockers.length > 0 || planQuery.isFetching}>
                Next
              </Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={() => setStep("review")}>Back</Button>
              <Button
                variant="destructive"
                onClick={() => executeMutation.mutate()}
                disabled={!plan || plan.blockers.length > 0 || executeMutation.isPending || planQuery.isFetching}
              >
                {executeMutation.isPending ? "Handing over..." : "Hand over and remove"}
              </Button>
            </>
          )}
          {step === "done" && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HandoverItemRow({
  item,
  options,
  value,
  planned,
  onChange,
}: {
  item: MemberHandoverItem;
  options: Array<{ value: string; label: string }> | null;
  value: string;
  planned: string;
  onChange: (value: string) => void;
}) {
  const title = item.count && item.count > 1 ? `${item.title} (${item.count})` : item.title;
  return (
    <div
      data-handover-item={item.ref}
      className={`flex flex-wrap items-start justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 ${item.blocker ? "bg-destructive/5" : ""}`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">
          {item.link ? <Link to={item.link} className="hover:underline">{title}</Link> : title}
        </div>
        {item.detail ? <div className="text-muted-foreground">{item.detail}</div> : null}
        {item.blocker ? <div className="text-destructive">{item.blocker}</div> : null}
        {item.warning ? <div className="text-muted-foreground">{item.warning}</div> : null}
      </div>
      <div className="w-full shrink-0 sm:w-64">
        {options ? (
          <select
            aria-label={`Where ${item.title} goes`}
            className="w-full rounded-md border border-border bg-background px-2 py-1"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <div className="text-muted-foreground">{planned}</div>
        )}
      </div>
    </div>
  );
}

function HandoverSummary({ plan, successorName }: { plan: MemberHandoverPlan; successorName: string }) {
  const counts = plan.counts;
  const lines = [
    `${plural(counts.issues ?? 0, "open task")} moved${counts.issuesClosed ? `, ${plural(counts.issuesClosed, "closed")}` : ""}`,
    `${plural(counts.interactions ?? 0, "pending question or request", "pending questions or requests")} moved`,
    `${plural(counts.routines ?? 0, "routine")} moved`,
    counts.queuedRuns ? `${plural(counts.queuedRuns, "queued run")} moved` : null,
    `${plural(counts.agentsRepointed ?? 0, "agent")} pointed at another AI account`,
    `${plural(counts.connectionsRevoked ?? 0, "personal connection")} revoked`,
    `${plural(counts.memoryGrantsRemoved ?? 0, "memory right")} and ${plural(counts.permissionGrantsRemoved ?? 0, "permission")} removed`,
    `${plural(counts.boardKeysRevoked ?? 0, "board API key")} revoked, ${plural(counts.sessionsEnded ?? 0, "sign-in session")} ended`,
    `Membership ${plan.items.find((item) => item.kind === "membership")?.planned.type === "suspend" ? "suspended" : "archived"}`,
  ].filter((line): line is string => Boolean(line));
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="font-medium">Most things go to {successorName}</div>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {plan.reconnect.length > 0 && (
        <div className="space-y-1">
          <div className="font-medium">{successorName} needs to reconnect</div>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {plan.reconnect.map((entry) => <li key={`${entry.kind}:${entry.name}`}>{entry.name}: {entry.detail}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
