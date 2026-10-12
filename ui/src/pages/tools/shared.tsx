import type { ReactNode } from "react";
import type {
  ToolRiskLevel,
  ToolConnectionHealthStatus,
  ToolPolicyDecision,
} from "@greatstone/shared";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { ErrorState as SharedErrorState, errorStateMessage } from "@/components/ErrorState";
import { ApiError } from "@/api/client";

/** Risk classification badge for a catalog tool. */
export function RiskBadge({ risk }: { risk: ToolRiskLevel | null | undefined }) {
  if (!risk) return <Badge variant="outline">unknown</Badge>;
  const variant =
    risk === "high" || risk === "critical"
      ? "destructive"
      : risk === "medium"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{risk}</Badge>;
}

/** Read/Write/Destructive capability chips. */
export function CapabilityBadges({
  isReadOnly,
  isWrite,
  isDestructive,
}: {
  isReadOnly?: boolean;
  isWrite?: boolean;
  isDestructive?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {isReadOnly ? <Badge variant="outline">read-only</Badge> : null}
      {isWrite ? <Badge variant="secondary">write</Badge> : null}
      {isDestructive ? <Badge variant="destructive">destructive</Badge> : null}
    </span>
  );
}

/** Catalog quarantine marker — canonical status key. */
export function QuarantineBadge() {
  return <StatusBadge status="quarantined" />;
}

function healthToStatusKey(status: string): string {
  switch (status) {
    case "healthy":
    case "ok":
    case "":
      return "healthy";
    case "degraded":
    case "warning":
      return "degraded";
    case "error":
    case "unhealthy":
    case "critical":
      return "runtime-error";
    case "unchecked":
    case "unknown":
      return "unchecked";
    default:
      return status;
  }
}

/** Connection / runtime health badge, mapped onto canonical status colors. */
export function HealthBadge({
  status,
  label,
}: {
  status: ToolConnectionHealthStatus | string | null | undefined;
  label?: string;
}) {
  const raw = (status ?? "unknown").toString();
  return <StatusBadge status={healthToStatusKey(raw)} label={label ?? raw} />;
}

function decisionToStatusKey(decision: string): { key: string; label: string } {
  switch (decision) {
    case "allow":
    case "allowed":
      return { key: "allowed", label: "allowed" };
    case "deny":
    case "denied":
      return { key: "denied", label: "denied" };
    case "block":
      return { key: "block", label: "block" };
    case "require_approval":
    case "requires_approval":
      return { key: "require-approval", label: "require approval" };
    case "redact":
    case "redacted":
      return { key: "redacted", label: "redacted" };
    case "rate_limited":
      return { key: "rate-limit", label: "rate limited" };
    case "defer":
    case "deferred":
      return { key: "deferred", label: "deferred" };
    case "hidden":
      return { key: "hidden", label: "hidden" };
    default:
      return { key: decision, label: decision };
  }
}

/** Policy/gateway decision badge — canonical status colors. */
export function DecisionBadge({ decision }: { decision: ToolPolicyDecision | string | null | undefined }) {
  if (!decision) return <Badge variant="outline">None</Badge>;
  const { key, label } = decisionToStatusKey(decision.toString());
  return <StatusBadge status={key} label={label} />;
}

/** Compact relative time, falling back to absolute. */
export function RelativeTime({ value }: { value: Date | string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">never</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">unknown</span>;
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const isFuture = diffMs < 0;
  let text: string;
  if (mins < 1) text = "just now";
  else {
    const value =
      mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    text = isFuture ? `in ${value}` : `${value} ago`;
  }
  return (
    <span title={date.toLocaleString()} className="text-muted-foreground">
      {text}
    </span>
  );
}

export function ToolsPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/** Skeleton rows; the label is kept for screen readers only. */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-2 py-4">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function toolsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "You do not have permission to view this. Tools & Access requires board/admin access.";
    }
    if (error.status === 404 || /route not found/i.test(error.message)) {
      // Snapshot-skew window: the route exists in this build but not on the live server snapshot yet.
      return "Tools & Access isn't available on this server yet. Try refreshing after the next deployment.";
    }
  }
  return errorStateMessage(error);
}

/** Shared ErrorState with the Tools & Access 403/404 messages. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <SharedErrorState
      compact
      title="Could not load this view"
      error={toolsErrorMessage(error)}
      onRetry={onRetry}
    />
  );
}

/**
 * Honest notice for surfaces whose backend contract has not shipped yet.
 * This must NOT pretend to enforce anything client-side — it links the
 * follow-up issue that owns the missing contract.
 */
export function PendingBackendNotice({
  title,
  body,
  issue,
}: {
  title: string;
  body: ReactNode;
  issue?: { identifier: string; href: string };
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col gap-2 py-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {title}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{body}</p>
        {issue ? (
          <a href={issue.href} className="text-sm font-medium text-primary hover:underline">
            Tracked in {issue.identifier} →
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
