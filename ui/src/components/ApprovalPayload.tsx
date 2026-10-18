import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, KeyRound } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { formatCents } from "../lib/utils";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import type { PermissionKey } from "@greatstone/shared";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire an agent",
  approve_ceo_strategy: "Strategy from the CEO",
  budget_override_required: "Over budget",
  request_board_approval: "Needs your approval",
  permission_grant: "Permission request",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire an agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  permission_grant: KeyRound,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "Not set")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Runs on</span>
          <span title={String(payload.adapterType)}>
            {getAdapterDisplay(String(payload.adapterType)).label}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

const SCOPE_TYPE_LABELS: Record<string, string> = {
  company: "The whole organisation",
  agent: "An agent",
  project: "A project",
};

/** Plain words for a budget scope type, used when the payload has no scope name. */
export function scopeTypeLabel(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return SCOPE_TYPE_LABELS[value] ?? value;
}

const PERMISSION_KEY_LABELS: Record<PermissionKey, string> = {
  "agents:create": "Add new agents",
  "agents:configure": "Change agent settings",
  "agents:suggest-changes": "Suggest changes to agents",
  "skills:create": "Create and edit skills",
  "skills:suggest-changes": "Suggest changes to skills",
  "environments:manage": "Manage environments",
  "tools:admin": "Administer tools",
  "tools:manage_connections": "Manage tool connections",
  "tools:manage_profiles": "Manage tool profiles",
  "tools:view_audit": "See the tool usage log",
  "audit:view_agent_actions": "See what agents have done",
  "tools:use": "Use tools",
  "tools:manage_runtime": "Manage how tools run",
  "inbox:manage": "Manage the inbox",
  "users:invite": "Invite people",
  "users:manage_permissions": "Change what people can do",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign tasks within a set area",
  "tasks:manage_active_checkouts": "Take over tasks that are in progress",
  "pipelines:cases": "Work cases in pipelines",
  "pipelines:write": "Administer pipelines",
  "joins:approve": "Approve requests to join",
  "memory:read": "Read organisation memory",
  "memory:contribute": "Add to organisation memory",
  "memory:approve": "Approve memory changes",
  "memory:correct": "Correct organisation memory",
  "memory:delete": "Delete from organisation memory",
  "memory:admin": "Manage organisation memory",
  "strategy:board_member": "See the strategy as a board member",
  "strategy:board_chair": "Chair the board",
  "intelligence:write": "Write intelligence reports",
};

/** Plain words for a permission key, e.g. "tasks:assign" becomes "Assign tasks". */
export function permissionKeyLabel(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return value;
  const known = (PERMISSION_KEY_LABELS as Record<string, string>)[value];
  if (known) return known;
  const [area, ...rest] = value.split(":");
  const humanise = (part: string) => part.replace(/[_-]+/g, " ").trim();
  const head = humanise(area);
  const label = head.charAt(0).toUpperCase() + head.slice(1);
  const tail = humanise(rest.join(":"));
  return tail ? `${label}: ${tail}` : label;
}

function budgetWindowLabel(value: unknown): unknown {
  if (value === "calendar_month_utc") return "This month";
  if (value === "lifetime") return "All time";
  return value;
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Applies to" value={payload.scopeName ?? scopeTypeLabel(payload.scopeType)} />
      <PayloadField label="Period" value={budgetWindowLabel(payload.windowKind)} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "not set"} · Spent {observedAmount !== null ? formatCents(observedAmount) : "nothing yet"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

/**
 * Risks render inside a custom bullet row, so a leading markdown list marker
 * would nest a second bullet inside the first. Strip one leading marker.
 */
function stripLeadingListMarker(value: string): string {
  return value.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => stripLeadingListMarker(value.trim()))
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Summary</p>
          <MarkdownBody className="leading-6 text-foreground/90">{summary}</MarkdownBody>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{recommendedAction}</MarkdownBody>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">On approval</p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</MarkdownBody>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk, index) => (
              <li key={`${index}-${risk}`} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <MarkdownBody className="leading-6">{risk}</MarkdownBody>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

/** GRE-601: an agent was refused for a missing permission. */
function PermissionGrantPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Agent" value={payload.agentName} />
      <PayloadField label="Permission" value={permissionKeyLabel(payload.permissionKey)} />
      <PayloadField label="Task" value={payload.issueIdentifier} />
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "permission_grant") return <PermissionGrantPayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
