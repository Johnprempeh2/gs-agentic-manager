import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StrategyBoardKpi } from "@greatstone/shared";
import { AlertTriangle, FileText, Network } from "lucide-react";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { boardAssurance, meetingPackId } from "@/lib/strategy-board";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttentionQueue, ChangesSinceSnapshot, StrategyAtAGlance } from "@/components/strategy-board/StrategyBoardViews";
import { AskWhyDialog, BoardMembersCard, BoardPackViewer, MakeBoardPackDialog } from "@/components/strategy-board/StrategyBoardDialogs";

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/** "On course 2 · Watch 1 · Off course 1 · 2 KPIs on weak evidence" */
export function boardLede(counts: { red: number; amber: number; green: number; noStatus: number }, kpis: readonly StrategyBoardKpi[]): string {
  const weak = kpis.filter((kpi) => kpi.status && boardAssurance(kpi) === "weak").length;
  const parts = [`On course ${counts.green}`, `Watch ${counts.amber}`, `Off course ${counts.red}`];
  if (counts.noStatus) parts.push(`${counts.noStatus} with no status`);
  if (weak) parts.push(`${weak} on weak evidence`);
  return parts.join(" · ");
}

/** Why some red KPIs sent no alert, and what to do about it. */
export function unsentAlertText(count: number, hasChair: boolean, mayManageMembers: boolean): string {
  const kpis = count === 1 ? "1 KPI" : `${count} KPIs`;
  if (hasChair) {
    return `${kpis} turned red before the board had a chair, so no alert was sent for ${count === 1 ? "it" : "them"}. New red KPIs alert the chair.`;
  }
  return `${kpis} ${count === 1 ? "is" : "are"} red and the board has no chair, so no alert was sent. ${
    mayManageMembers ? "Choose a chair below." : "Ask a company owner to choose a chair."
  }`;
}

/**
 * Board control panel (GRE-1135, design view GRE-1134): exceptions first,
 * then the strategy at a glance, what changed since the last board pack,
 * and the board packs. Read-mostly: the only board actions are "Ask why"
 * and "Make board pack".
 */
export function StrategyBoard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [askKpi, setAskKpi] = useState<StrategyBoardKpi | null>(null);
  const [makingPack, setMakingPack] = useState(false);
  const [openPackId, setOpenPackId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Board" }]);
  }, [setBreadcrumbs]);

  const { data: board, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.strategyBoard.summary(selectedCompanyId!),
    queryFn: () => strategyBoardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: packs } = useQuery({
    queryKey: queryKeys.strategyBoard.packs(selectedCompanyId!),
    queryFn: () => strategyBoardApi.listPacks(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error || !board) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const rights = board.viewer;
  const meetingPack = packs ? meetingPackId(packs) : null;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Board control panel</p>
          <h1 className="text-xl font-bold">Are we on course?</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            As of {board.asOf}
            {board.lastSnapshot ? ` · compared with “${board.lastSnapshot.title}”` : ""} · {boardLede(board.counts, board.kpis)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link to="/goals">
              <Network className="size-3.5" />
              Full strategy
            </Link>
          </Button>
          {rights.mayMakeBoardPack ? (
            <Button size="sm" onClick={() => setMakingPack(true)}>
              <FileText className="size-3.5" />
              Make board pack
            </Button>
          ) : null}
        </div>
      </header>

      {board.unsentAlerts > 0 ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
          <span>{unsentAlertText(board.unsentAlerts, board.hasChair, rights.mayManageMembers)}</span>
        </div>
      ) : null}

      <section className="space-y-2" aria-labelledby="attention-heading">
        <SectionHeading id="attention-heading">Needs board attention</SectionHeading>
        <AttentionQueue kpis={board.attention} canAskWhy={rights.mayAskWhy} onAskWhy={setAskKpi} />
      </section>

      <section className="space-y-2" aria-labelledby="glance-heading">
        <SectionHeading id="glance-heading">Strategy at a glance</SectionHeading>
        <StrategyAtAGlance areas={board.areas} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2" aria-labelledby="changes-heading">
          <SectionHeading id="changes-heading">Changed since the last board pack</SectionHeading>
          <ChangesSinceSnapshot kpis={board.changes} hasSnapshot={board.lastSnapshot != null} />
        </section>

        <section className="space-y-2" aria-labelledby="packs-heading">
          <SectionHeading id="packs-heading">Board packs</SectionHeading>
          {packs && packs.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {packs.map((pack) => (
                <li key={pack.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
                    onClick={() => setOpenPackId(pack.id)}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium">{pack.title}</span>
                      {pack.status === "draft" ? <Badge variant="outline">Draft</Badge> : null}
                      {pack.id === meetingPack ? <Badge variant="secondary">Meeting pack</Badge> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{pack.periodStart} to {pack.periodEnd}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No board pack yet.</p>
          )}
        </section>
      </div>

      {rights.mayManageMembers ? (
        <section className="space-y-2" aria-labelledby="members-heading">
          <SectionHeading id="members-heading">Board members</SectionHeading>
          <BoardMembersCard companyId={selectedCompanyId!} />
        </section>
      ) : null}

      <AskWhyDialog companyId={selectedCompanyId!} kpi={askKpi} onClose={() => setAskKpi(null)} />
      {makingPack ? (
        <MakeBoardPackDialog
          companyId={selectedCompanyId!}
          open={makingPack}
          onClose={() => setMakingPack(false)}
          onCreated={(pack) => {
            setMakingPack(false);
            setOpenPackId(pack.id);
          }}
        />
      ) : null}
      <BoardPackViewer
        companyId={selectedCompanyId!}
        packId={openPackId}
        canAccept={rights.mayMakeBoardPack}
        onClose={() => setOpenPackId(null)}
      />
    </div>
  );
}
