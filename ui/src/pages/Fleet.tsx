import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Server } from "lucide-react";
import type { FleetInstanceState, FleetInstanceView } from "@greatstone/shared/fleet";
import { ApiError } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useFleetInstances } from "@/hooks/useFleetInstances";
import { formatBytes } from "@/lib/issue-output";
import { formatCents, formatNumber, relativeTime } from "@/lib/utils";

/**
 * Fleet page (GRE-1083, F2 on GRE-1069 slide 26). Greatstone hub only: the
 * server answers 404 off the hub and 403 to anyone who is not an instance
 * admin. Read-only: no button here sends anything to an instance.
 *
 * Every value is what the instance's last check-in said (GRE-1082, v2 from
 * GRE-1366). The state comes from the server's `fleetInstanceState`; this file
 * has no second rule.
 */

type ChipTone = "done" | "blocked" | "todo" | "backlog" | "in_progress";

const STATE_CHIP: Record<FleetInstanceState, { tone: ChipTone; label: string }> = {
  ok: { tone: "done", label: "OK" },
  stale: { tone: "todo", label: "Stale" },
  down: { tone: "blocked", label: "Down" },
  waiting: { tone: "in_progress", label: "Waiting for check-in" },
  pending: { tone: "backlog", label: "Not registered" },
  paused: { tone: "backlog", label: "Paused" },
  archived: { tone: "backlog", label: "Archived" },
  revoked: { tone: "blocked", label: "Revoked" },
};

const EDITION_LABEL: Record<string, string> = {
  managed: "Managed",
  "managed-plus": "Managed plus",
  internal: "Internal",
};

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ "--sc": `var(--status-task-${tone})` } as CSSProperties}
    >
      {children}
    </span>
  );
}

/** Minutes as a short age: 45m, 6h, 3d. */
export function formatAgeMinutes(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function HealthCell({ instance }: { instance: FleetInstanceView }) {
  const health = instance.latestCheckIn?.checkIn.health;
  if (!health) return <Muted>—</Muted>;
  const check = (label: string, value: { ok: boolean; ageMinutes: number } | null) =>
    value ? `${label} ${value.ok ? "ok" : "failed"}, ${formatAgeMinutes(value.ageMinutes)} ago` : `${label} not set up`;
  return (
    <div className="space-y-0.5">
      <div>App {health.app === "ok" ? "up" : "down"}</div>
      <div className="text-xs text-muted-foreground">
        {health.backupAgeMinutes === null ? "No backup" : `Backup ${formatAgeMinutes(health.backupAgeMinutes)} ago`}
      </div>
      <div className="text-xs text-muted-foreground">{check("Restore check", health.restoreCheck)}</div>
      <div className="text-xs text-muted-foreground">{check("Offsite", health.offsiteBackup)}</div>
    </div>
  );
}

function VersionCell({ instance }: { instance: FleetInstanceView }) {
  const version = instance.latestCheckIn?.checkIn.version;
  if (!version) return <Muted>—</Muted>;
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-xs">{version.releaseTag ?? "No release tag"}</div>
      {version.appVersion ? <div className="text-xs text-muted-foreground">App {version.appVersion}</div> : null}
      {version.lastUpgrade ? (
        <div className="text-xs text-muted-foreground">Upgraded {formatAgeMinutes(version.lastUpgrade.ageMinutes)} ago</div>
      ) : null}
    </div>
  );
}

function UsageCell({ instance }: { instance: FleetInstanceView }) {
  const usage = instance.latestCheckIn?.checkIn.usage;
  if (!usage) return <Muted>—</Muted>;
  const failed = "runsFailedLast24h" in usage ? usage.runsFailedLast24h : null;
  return (
    <div className="space-y-0.5">
      <div className="tabular-nums">
        AI spend {formatCents(usage.spendCentsMonth)}
        {usage.budgetCentsMonth > 0 ? <Muted> of {formatCents(usage.budgetCentsMonth)}</Muted> : <Muted> (no budget)</Muted>}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatNumber(usage.companies)} companies, {formatNumber(usage.activeAgents)} active agents
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatNumber(usage.runsLast24h)} runs in 24h{failed !== null ? `, ${formatNumber(failed)} failed` : ""}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">{formatBytes(usage.storageBytes)} stored</div>
    </div>
  );
}

function ConnectionsCell({ instance }: { instance: FleetInstanceView }) {
  const checkIn = instance.latestCheckIn?.checkIn;
  // v1 check-ins carry no connection counts; v2 sends null when the app is not up to ask.
  const connections = checkIn && "connections" in checkIn ? checkIn.connections : null;
  if (!connections) return <Muted>—</Muted>;
  return (
    <div className="space-y-0.5 tabular-nums">
      <div>
        AI {formatNumber(connections.ai.healthy)} ok
        {connections.ai.needsAttention > 0 ? `, ${formatNumber(connections.ai.needsAttention)} need attention` : ""}
      </div>
      <div className="text-xs text-muted-foreground">
        Tools {formatNumber(connections.tools.active)} on, {formatNumber(connections.tools.disabled)} off
      </div>
    </div>
  );
}

function AlertsCell({ instance }: { instance: FleetInstanceView }) {
  const alerts = instance.latestCheckIn?.checkIn.alerts;
  if (!alerts) return <Muted>—</Muted>;
  const failing = alerts.filter((alert) => !alert.ok);
  if (failing.length === 0) return <Muted>None</Muted>;
  return (
    <ul className="space-y-0.5">
      {failing.map((alert) => (
        <li key={alert.key} className="font-mono text-xs text-destructive">
          {alert.key}
        </li>
      ))}
    </ul>
  );
}

function stateNote(instance: FleetInstanceView) {
  if ((instance.state === "paused" || instance.state === "archived") && instance.lifecycleChangedAt) {
    return `since ${relativeTime(instance.lifecycleChangedAt)}`;
  }
  if (instance.state === "revoked" && instance.revokedAt) return `${relativeTime(instance.revokedAt)}`;
  return null;
}

const COLUMNS = ["Instance", "State", "Last check-in", "Health", "Version", "Usage", "Connections", "Alerts"];

export function Fleet() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const query = useFleetInstances();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Fleet" },
    ]);
  }, [setBreadcrumbs]);

  if (query.isLoading) return <PageSkeleton variant="list" />;

  const status = query.error instanceof ApiError ? query.error.status : null;
  if (!query.isAdmin || status === 403 || status === 404) {
    return (
      <EmptyState
        icon={Server}
        title="Fleet is not available here"
        message="The fleet page is only on the Greatstone hub, for its instance admins."
      />
    );
  }

  if (query.error || !query.data) {
    return (
      <p role="alert" className="mx-auto max-w-3xl text-sm text-destructive">
        The fleet could not be loaded. Try again in a moment.
      </p>
    );
  }

  const instances = query.data;

  return (
    <div className="space-y-4" data-testid="fleet-page">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Fleet</h1>
        <p className="text-sm text-muted-foreground">
          Each registered client instance and what its last check-in said. Read-only; this page sends nothing to an
          instance.
        </p>
      </div>

      {instances.length === 0 ? (
        <EmptyState icon={Server} title="No instances yet" message="An instance shows here once it is added to the hub." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm" data-testid="fleet-table">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {instances.map((instance) => {
                const chip = STATE_CHIP[instance.state];
                const note = stateNote(instance);
                const edition = instance.latestCheckIn?.checkIn.edition;
                return (
                  <tr key={instance.id} className="align-top" data-testid={`fleet-row-${instance.code}`}>
                    <td className="px-3 py-2">
                      <div className="font-mono font-medium">{instance.code}</div>
                      {edition ? <div className="text-xs text-muted-foreground">{EDITION_LABEL[edition] ?? edition}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Chip tone={chip.tone}>{chip.label}</Chip>
                      {note ? <div className="mt-1 text-xs text-muted-foreground">{note}</div> : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {instance.lastCheckInAt ? relativeTime(instance.lastCheckInAt) : <Muted>Never</Muted>}
                    </td>
                    <td className="px-3 py-2"><HealthCell instance={instance} /></td>
                    <td className="px-3 py-2"><VersionCell instance={instance} /></td>
                    <td className="px-3 py-2"><UsageCell instance={instance} /></td>
                    <td className="px-3 py-2"><ConnectionsCell instance={instance} /></td>
                    <td className="px-3 py-2"><AlertsCell instance={instance} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
