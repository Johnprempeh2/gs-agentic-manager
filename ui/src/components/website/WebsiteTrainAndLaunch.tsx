import type { ReactNode } from "react";
import { Flag, TrainFront } from "lucide-react";
import type { WebsiteHomeIssueLink, WebsiteHomeLaunch, WebsiteHomeTrain, WebsiteTrainState } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { IssueStatusBadge } from "../StatusBadge";
import { When, taskHref } from "./WebsiteHub";

// The weekly website release train and the new-site launch countdown on the
// Website Home (John, GRE-2641, 25 Oct 2026). Both come from the Home read.

export const TRAIN_STATE_COPY: Record<WebsiteTrainState, { label: string; tone: string }> = {
  none: { label: "No train this week", tone: "bg-status-neutral-soft text-status-neutral-foreground" },
  cut: { label: "Cut", tone: "bg-status-info-soft text-status-info-foreground" },
  checking: { label: "Checking", tone: "bg-status-info-soft text-status-info-foreground" },
  waiting_for_approval: { label: "Waiting for approval", tone: "bg-status-warning-soft text-status-warning-foreground" },
  approved: { label: "Approved", tone: "bg-status-success-soft text-status-success-foreground" },
  rejected: { label: "Not approved", tone: "bg-status-danger-soft text-status-danger" },
  live: { label: "Live", tone: "bg-status-success-soft text-status-success-foreground" },
};

/** "Tue 3 Nov 2026" from `YYYY-MM-DD`, on the calendar day itself. */
export function launchDateLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const part = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
  return `${part({ weekday: "short" })} ${d} ${part({ month: "short" })} ${y}`;
}

/** "9 days left", "Launch day", "2 days ago". */
export function daysLeftLabel(days: number): string {
  if (days === 0) return "Launch day";
  if (days < 0) return days === -1 ? "1 day ago" : `${-days} days ago`;
  return days === 1 ? "1 day left" : `${days} days left`;
}

function nextTrainLabel(at: string): string {
  return new Date(at).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Pill({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return (
    <span className={cn("inline-flex w-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", tone)} data-testid={testId}>
      {children}
    </span>
  );
}

function IssueLink({ issue, children }: { issue: WebsiteHomeIssueLink; children?: ReactNode }) {
  return (
    <Link to={taskHref(issue)} className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {children ?? issue.identifier ?? issue.title}
    </Link>
  );
}

function Panel({ title, icon: Icon, testId, children }: { title: string; icon: typeof Flag; testId: string; children: ReactNode }) {
  const headingId = `${testId}-title`;
  return (
    <section className="gs-glass-card flex min-w-0 flex-col gap-3 rounded-xl border p-4" aria-labelledby={headingId} data-testid={testId}>
      <h2 id={headingId} className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      </h2>
      {children}
    </section>
  );
}

function cardLine(card: NonNullable<WebsiteHomeTrain["card"]>): ReactNode {
  const by = card.resolvedByName ? <> by <span className="text-foreground">{card.resolvedByName}</span></> : null;
  const at = card.resolvedAt ? <>, <When at={card.resolvedAt} /></> : null;
  if (card.status === "pending") return "Release card waiting for John or Ben";
  if (card.status === "accepted") return <>Release card approved{by}{at}</>;
  if (card.status === "rejected") return <>Release card not approved{by}{at}</>;
  return `Release card ${card.status}`;
}

export function TrainPanel({ train }: { train: WebsiteHomeTrain | null }) {
  const next = train?.nextRunAt ? (
    <p className="text-xs text-muted-foreground" data-testid="website-home-train-next">
      Next train <time dateTime={train.nextRunAt}>{nextTrainLabel(train.nextRunAt)}</time>
    </p>
  ) : null;
  if (!train?.issue) {
    return (
      <Panel title="Weekly release train" icon={TrainFront} testId="website-home-train">
        <p className="text-sm font-semibold">No train yet</p>
        <p className="text-xs text-muted-foreground">Each Monday merged website work goes out on one release card for John or Ben.</p>
        {next}
      </Panel>
    );
  }
  const copy = TRAIN_STATE_COPY[train.state];
  return (
    <Panel title="Weekly release train" icon={TrainFront} testId="website-home-train">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">This week</span>
        <Pill tone={copy.tone} testId="website-home-train-state">{copy.label}</Pill>
      </div>
      <p className="min-w-0 text-sm text-muted-foreground">
        <IssueLink issue={train.issue} />
        {" · "}
        {train.tag ? <span className="break-all font-mono text-foreground">{train.tag}</span> : "No tag yet"}
      </p>
      {train.card ? <p className="text-sm text-muted-foreground" data-testid="website-home-train-card">{cardLine(train.card)}</p> : null}
      {next}
    </Panel>
  );
}

export function LaunchPanel({ launch }: { launch: WebsiteHomeLaunch | null }) {
  if (!launch?.targetDate) {
    return (
      <Panel title="New site launch" icon={Flag} testId="website-home-launch">
        <p className="text-sm font-semibold">No launch date yet</p>
        <p className="text-xs text-muted-foreground">The date and its gates show here once one is proposed.</p>
      </Panel>
    );
  }
  const agreed = launch.agreement === "agreed";
  return (
    <Panel title="New site launch" icon={Flag} testId="website-home-launch">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {launch.daysLeft !== null ? <span className="text-2xl font-bold tabular-nums" data-testid="website-home-launch-days">{daysLeftLabel(launch.daysLeft)}</span> : null}
        <span className="text-sm text-muted-foreground">{launchDateLabel(launch.targetDate)}</span>
        <Pill tone={agreed ? "bg-status-success-soft text-status-success-foreground" : "bg-status-warning-soft text-status-warning-foreground"} testId="website-home-launch-agreement">
          {agreed ? "Agreed" : "Proposed"}
        </Pill>
      </div>
      {!agreed && launch.cardIssue ? (
        <p className="text-xs text-muted-foreground">
          Waiting for John or Ben on the launch card in <IssueLink issue={launch.cardIssue} />.
        </p>
      ) : null}
      <ul className="divide-y divide-border" aria-label="Launch gates">
        {launch.gates.map((gate) => (
          <li key={gate.identifier} className="flex min-w-0 items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{gate.label}</span>
            {gate.issue ? (
              <>
                <span className="shrink-0 text-xs"><IssueLink issue={gate.issue} /></span>
                <IssueStatusBadge status={gate.issue.status} />
              </>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">{gate.identifier} not found</span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function TrainAndLaunch({ train, launch }: { train: WebsiteHomeTrain | null; launch: WebsiteHomeLaunch | null }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="website-home-train-and-launch">
      <TrainPanel train={train} />
      <LaunchPanel launch={launch} />
    </div>
  );
}
