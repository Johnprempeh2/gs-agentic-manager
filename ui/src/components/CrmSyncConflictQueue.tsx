import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  crmSyncIsOwnChangeOnly,
  type CrmSyncChangeAuthor,
  type CrmSyncConflict,
  type CrmSyncConflictResolution,
  type CrmSyncFieldValue,
} from "@greatstone/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

/** "fields.dealValue" → "Deal value"; title and summary keep their names. */
export function crmSyncFieldLabel(gsamField: string) {
  const key = gsamField.startsWith("fields.") ? gsamField.slice("fields.".length) : gsamField;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatCrmSyncValue(value: CrmSyncFieldValue | undefined) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return "Empty";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function authorNames(
  authors: CrmSyncChangeAuthor[],
  agentNames: Map<string, string>,
  currentUserId: string | null,
) {
  if (authors.length === 0) return null;
  return authors
    .map((author) => {
      if (author.actorType === "agent") return agentNames.get(author.agentId) ?? "An agent";
      return author.userId === currentUserId ? "You" : "A teammate";
    })
    .join(", ");
}

const RESOLUTION_LABELS: Record<CrmSyncConflictResolution, string> = {
  keep_crm: "Keep the CRM value",
  keep_gsam: "Keep the GSAM value",
  custom: "Use a typed value",
};

type Decision =
  | { type: "resolve"; resolution: "keep_crm" | "keep_gsam"; reason?: string }
  | { type: "custom"; value: string; reason?: string }
  | { type: "accept_proposal" }
  | { type: "dismiss"; reason?: string };

function ConflictItem({
  item,
  agentNames,
  currentUserId,
  pipelineId,
  showCaseLink,
}: {
  item: CrmSyncConflict;
  agentNames: Map<string, string>;
  currentUserId: string | null;
  pipelineId: string | null;
  showCaseLink: boolean;
}) {
  const queryClient = useQueryClient();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const suggestion = item.kind === "suggestion";
  const ownOnly = currentUserId ? crmSyncIsOwnChangeOnly(item.gsamChangedBy, currentUserId) : false;
  const changedBy = authorNames(item.gsamChangedBy, agentNames, currentUserId);
  const proposer = item.proposal
    ? item.proposal.proposedByAgentId
      ? agentNames.get(item.proposal.proposedByAgentId) ?? "An agent"
      : item.proposal.proposedByUserId === currentUserId ? "You" : "A teammate"
    : null;

  const decide = useMutation({
    mutationFn: (decision: Decision) => {
      const why = "reason" in decision && decision.reason?.trim() ? decision.reason.trim() : undefined;
      switch (decision.type) {
        case "resolve":
          return pipelinesApi.resolveCrmSyncConflict(item.id, { resolution: decision.resolution, ...(why ? { reason: why } : {}) });
        case "custom":
          return pipelinesApi.resolveCrmSyncConflict(item.id, {
            resolution: "custom",
            value: decision.value.trim() === "" ? null : decision.value,
            ...(why ? { reason: why } : {}),
          });
        case "accept_proposal":
          return pipelinesApi.acceptCrmSyncProposal(item.id);
        case "dismiss":
          return pipelinesApi.dismissCrmSyncConflict(item.id, why);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pipelines", "crm-sync-conflicts", item.companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseCrmSync(item.entityId) }),
      ]);
    },
  });

  const pending = decide.isPending;
  const fieldLabel = crmSyncFieldLabel(item.gsamField);

  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">{fieldLabel}</span>
        <Badge variant="outline" className="border-border text-(length:--text-micro) font-semibold text-muted-foreground">
          {suggestion ? "Suggested change" : "Changed in both places"}
        </Badge>
        {showCaseLink ? (
          pipelineId ? (
            <Link to={`/pipelines/${pipelineId}/items/${item.entityId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              Deal {item.externalId}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">Deal {item.externalId}</span>
          )
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(item.detectedAt)}</span>
      </div>

      <dl className="grid gap-1 sm:grid-cols-2 sm:gap-3">
        <div className="min-w-0 rounded-sm border border-border px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">
            In the CRM{item.crmChangedAt && !suggestion ? ` · changed ${relativeTime(item.crmChangedAt)}` : ""}
          </dt>
          <dd className="text-foreground [overflow-wrap:anywhere]">{formatCrmSyncValue(item.crmValue)}</dd>
        </div>
        <div className="min-w-0 rounded-sm border border-border px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">
            {suggestion ? "Suggested" : "In GSAM"}
            {changedBy ? ` · by ${changedBy}` : ""}
            {item.gsamChangedAt ? `, ${relativeTime(item.gsamChangedAt)}` : ""}
          </dt>
          <dd className="text-foreground [overflow-wrap:anywhere]">{formatCrmSyncValue(item.gsamValue)}</dd>
        </div>
      </dl>
      {item.reason ? <p className="text-xs text-muted-foreground">Why: {item.reason}</p> : null}

      {item.proposal ? (
        <div className="rounded-sm border border-border bg-muted/40 px-2 py-1.5 text-xs">
          <p className="text-foreground">
            {proposer} proposes: {RESOLUTION_LABELS[item.proposal.resolution]}
            {item.proposal.resolution === "custom" ? ` (${formatCrmSyncValue(item.proposal.value)})` : ""}
          </p>
          <p className="text-muted-foreground">{item.proposal.reason}</p>
        </div>
      ) : null}

      {ownOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">This holds only your change. Someone else decides.</p>
          {suggestion ? (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide.mutate({ type: "dismiss", reason: "Withdrawn" })}>
              Withdraw
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {typing ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label={`New value for ${fieldLabel}`}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Type the value both sides should hold"
              />
              <Button type="button" size="sm" disabled={pending} onClick={() => decide.mutate({ type: "custom", value: typed, reason })}>
                Save value
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setTyping(false)}>
                Cancel
              </Button>
            </div>
          ) : null}
          <Input
            aria-label="Reason for your decision"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why (optional, kept in the log)"
          />
          <div className="flex flex-wrap gap-2">
            {item.proposal ? (
              <Button type="button" size="sm" disabled={pending} onClick={() => decide.mutate({ type: "accept_proposal" })}>
                Accept proposal
              </Button>
            ) : null}
            {suggestion ? (
              <>
                <Button type="button" size="sm" variant={item.proposal ? "outline" : "default"} disabled={pending} onClick={() => decide.mutate({ type: "resolve", resolution: "keep_gsam", reason })}>
                  Accept and write to the CRM
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide.mutate({ type: "resolve", resolution: "keep_crm", reason })}>
                  Reject
                </Button>
              </>
            ) : (
              <>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide.mutate({ type: "resolve", resolution: "keep_crm", reason })}>
                  Keep CRM
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide.mutate({ type: "resolve", resolution: "keep_gsam", reason })}>
                  Keep GSAM
                </Button>
                {!typing ? (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setTyping(true)}>
                    Type a value
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
      {decide.error ? (
        <p role="alert" className="text-xs text-status-danger-foreground">
          {decide.error instanceof Error ? decide.error.message : "Could not save the decision. Try again."}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The "Sync conflicts" queue (GRE-1076): shared fields changed on both sides
 * and suggested changes to CRM-owned fields. Each held field stops syncing for
 * its case until a person decides; the decision is written to both sides on
 * the next pass. Pass `caseId` to show one case only. Renders nothing when the
 * queue is empty.
 */
export function CrmSyncConflictQueue({
  companyId,
  caseId,
  title = "Sync conflicts",
}: {
  companyId: string;
  caseId?: string;
  title?: string;
}) {
  const query = useQuery({
    queryKey: queryKeys.pipelines.crmSyncConflicts(companyId, caseId),
    queryFn: () => pipelinesApi.listCrmSyncConflicts(companyId, caseId ? { entityId: caseId } : {}),
    refetchInterval: 60_000,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const bindings = useQuery({
    queryKey: ["pipelines", "crm-sync-bindings", companyId],
    queryFn: () => pipelinesApi.listCrmSyncBindings(companyId),
    enabled: !caseId,
  });

  if (query.isLoading) return null;
  if (query.isError) {
    return <p className="py-2 text-sm text-muted-foreground">Could not load sync conflicts. Reload the page to try again.</p>;
  }
  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  const currentUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentNames = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name]));
  const pipelineByBinding = new Map((bindings.data ?? []).map((binding) => [binding.id, binding.pipelineId]));

  return (
    <section className="space-y-1" aria-label={title}>
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">
          {items.length} item{items.length === 1 ? "" : "s"} · held fields do not sync until decided
        </span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <ConflictItem
            key={item.id}
            item={item}
            agentNames={agentNames}
            currentUserId={currentUserId}
            pipelineId={pipelineByBinding.get(item.bindingId) ?? null}
            showCaseLink={!caseId}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * "Suggest a change" for CRM-owned fields on one case (GRE-1076). The CRM
 * owns these fields, so a change is sent for review and written to the CRM
 * only after a person accepts it. Renders nothing when no field is CRM-owned.
 */
export function CrmSyncSuggestChange({ caseId, bindingIds }: { caseId: string; bindingIds: string[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const maps = useQuery({
    queryKey: ["pipelines", "crm-sync-field-maps", ...bindingIds],
    queryFn: () => Promise.all(bindingIds.map((bindingId) => pipelinesApi.getCrmSyncFieldMap(bindingId))),
    enabled: bindingIds.length > 0,
  });
  const options = (maps.data ?? []).flatMap((map) =>
    map.fields
      .filter((field) => field.owner === "crm")
      .map((field) => ({
        key: `${map.bindingId}:${field.gsamField}`,
        bindingId: map.bindingId,
        gsamField: field.gsamField,
        label: field.externalFieldLabel ?? crmSyncFieldLabel(field.gsamField),
      })),
  );
  const selected = options.find((option) => option.key === choice) ?? options[0];

  const submit = useMutation({
    mutationFn: () => pipelinesApi.suggestCrmSyncChange(caseId, {
      gsamField: selected!.gsamField,
      value: value.trim() === "" ? null : value,
      reason: reason.trim(),
      ...(bindingIds.length > 1 ? { bindingId: selected!.bindingId } : {}),
    }),
    onSuccess: async (created) => {
      setOpen(false);
      setValue("");
      setReason("");
      setSent(true);
      await queryClient.invalidateQueries({ queryKey: ["pipelines", "crm-sync-conflicts", created.companyId] });
    },
  });

  if (options.length === 0) return null;
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2">
        <Button type="button" size="sm" variant="outline" onClick={() => { setOpen(true); setSent(false); }}>
          Suggest a change to a CRM field
        </Button>
        {sent ? <p role="status" className="text-xs text-muted-foreground">Sent for review. It is written to the CRM after a person accepts it.</p> : null}
      </div>
    );
  }
  return (
    <form
      className="space-y-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && reason.trim()) submit.mutate();
      }}
    >
      <p className="text-xs text-muted-foreground">The CRM owns these fields. A person reviews your change before it is written to the CRM.</p>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Field
        <NativeSelect value={selected?.key ?? ""} onChange={(event) => setChoice(event.target.value)}>
          {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </NativeSelect>
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">
        New value
        <Input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Why
        <Input value={reason} required onChange={(event) => setReason(event.target.value)} placeholder="For the reviewer and the log" />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submit.isPending || !reason.trim()}>Send for review</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {submit.error ? (
        <p role="alert" className="text-xs text-status-danger-foreground">
          {submit.error instanceof Error ? submit.error.message : "Could not send the suggestion. Try again."}
        </p>
      ) : null}
    </form>
  );
}
