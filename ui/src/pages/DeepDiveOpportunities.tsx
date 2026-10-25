import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Target, X } from "lucide-react";
import {
  DEEP_DIVE_BUILD_STATES,
  DEEP_DIVE_BUILD_STATES_NEEDING_WHY,
  DEEP_DIVE_BUILD_STATE_LABELS,
  DEEP_DIVE_FINDING_LABELS,
  DEEP_DIVE_KPI_DIRECTIONS,
  DEEP_DIVE_KPI_DIRECTION_LABELS,
  DEEP_DIVE_KPI_SCOPES,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_OPPORTUNITY_STATES,
  DEEP_DIVE_OPPORTUNITY_STATE_LABELS,
  DEEP_DIVE_VISIBILITIES,
  deepDiveBuildsFor,
  deepDiveKpiChange,
  deepDiveOpportunityGaps,
  type DeepDiveBuild,
  type DeepDiveBuildState,
  type DeepDiveKpi,
  type DeepDiveKpiDirection,
  type DeepDiveKpiScope,
  type DeepDiveOpportunity,
  type DeepDiveOpportunityBoard,
  type DeepDiveOpportunityState,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { deepDiveOpportunitiesApi, deepDiveOpportunitiesQueryKeys } from "@/api/deepDiveOpportunities";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";

// Deep Dive opportunities and KPIs (GRE-2370): Screen 7 of the GRE-2327 plan,
// from the website portal. Many validated findings point at one opportunity,
// one opportunity needs many builds, and each KPI has an owner, a baseline, a
// target and the processes that move it. Every link is ticked or picked here
// and saved at once; the page shows the board the server returns.

const SCOPE_LABELS: Record<DeepDiveKpiScope, string> = {
  company: "Company",
  division: "Division",
  department: "Department",
  team: "Team",
  individual: "Individual",
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** Adds or removes one id, keeping the order the links were made in. */
function toggled(ids: readonly string[], id: string, on: boolean): string[] {
  return on ? (ids.includes(id) ? [...ids] : [...ids, id]) : ids.filter((entry) => entry !== id);
}

type Run = (write: () => Promise<DeepDiveOpportunityBoard>) => void;

export function VisibilitySelect({ value, label, onChange }: { value: DeepDiveVisibility; label: string; onChange: (value: DeepDiveVisibility) => void }) {
  return (
    <NativeSelect aria-label={label} className="h-8 w-auto text-xs" value={value} onChange={(event) => onChange(event.target.value as DeepDiveVisibility)}>
      {DEEP_DIVE_VISIBILITIES.map((option) => (
        <option key={option} value={option}>{DEEP_DIVE_LABELS[option]}</option>
      ))}
    </NativeSelect>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      <X className="size-4" />
    </Button>
  );
}

/** A ticked list. Each tick saves the new set at once. */
export function LinkList({
  legend,
  options,
  selected,
  empty,
  onChange,
}: {
  legend: string;
  options: { id: string; label: string; note?: string }[];
  selected: readonly string[];
  empty: ReactNode;
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-muted-foreground">{legend}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {options.map((option) => {
            const inputId = `${legend}-${option.id}`.replace(/\s+/g, "-");
            return (
              <li key={option.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  id={inputId}
                  className="mt-0.5"
                  checked={selected.includes(option.id)}
                  onCheckedChange={(checked) => onChange(toggled(selected, option.id, checked === true))}
                />
                <label htmlFor={inputId} className="min-w-0 break-words">
                  {option.label}
                  {option.note ? <span className="text-xs text-muted-foreground"> · {option.note}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

function BuildRow({ build, board, run }: { build: DeepDiveBuild; board: DeepDiveOpportunityBoard; run: Run }) {
  const [state, setState] = useState<DeepDiveBuildState>(build.state);
  const [why, setWhy] = useState(build.stateWhy);
  useEffect(() => {
    setState(build.state);
    setWhy(build.stateWhy);
  }, [build.state, build.stateWhy]);
  const needsWhy = DEEP_DIVE_BUILD_STATES_NEEDING_WHY.has(state);
  const unsaved = state !== build.state || why !== build.stateWhy;

  function chooseState(next: DeepDiveBuildState) {
    setState(next);
    // A state that needs no reason saves at once; one that does waits for the reason.
    if (!DEEP_DIVE_BUILD_STATES_NEEDING_WHY.has(next)) run(() => deepDiveOpportunitiesApi.updateBuild(build.id, { state: next }));
  }

  return (
    <li className="space-y-1.5 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[10rem] flex-1 break-words text-sm font-medium">{build.ref ? `${build.ref} · ` : ""}{build.name}</span>
        <NativeSelect aria-label={`State of ${build.name}`} className="h-8 w-auto text-xs" value={state} onChange={(event) => chooseState(event.target.value as DeepDiveBuildState)}>
          {DEEP_DIVE_BUILD_STATES.map((option) => <option key={option} value={option}>{DEEP_DIVE_BUILD_STATE_LABELS[option]}</option>)}
        </NativeSelect>
        <NativeSelect
          aria-label={`Opportunity ${build.name} serves`}
          className="h-8 w-auto max-w-[12rem] text-xs"
          value={build.opportunityId ?? ""}
          onChange={(event) => {
            const opportunityId = event.target.value || null;
            run(() => deepDiveOpportunitiesApi.updateBuild(build.id, { opportunityId }));
          }}
        >
          <option value="">Serves no opportunity</option>
          {board.opportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>Serves {opportunity.name}</option>)}
        </NativeSelect>
        <VisibilitySelect value={build.visibility} label={`Sharing for ${build.name}`} onChange={(visibility) => run(() => deepDiveOpportunitiesApi.updateBuild(build.id, { visibility }))} />
        <RemoveButton label={`Remove ${build.name}`} onClick={() => run(() => deepDiveOpportunitiesApi.removeBuild(build.id))} />
      </div>
      {build.what ? <p className="text-xs text-muted-foreground">{build.what}</p> : null}
      {needsWhy || build.stateWhy ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (needsWhy && !why.trim()) return;
            run(() => deepDiveOpportunitiesApi.updateBuild(build.id, { state, stateWhy: why.trim() }));
          }}
        >
          <Input
            aria-label={`Why ${build.name} is ${DEEP_DIVE_BUILD_STATE_LABELS[state].toLowerCase()}`}
            className="h-8 min-w-0 flex-1 text-xs"
            placeholder="Why, so somebody can revisit it later"
            value={why}
            onChange={(event) => setWhy(event.target.value)}
          />
          {unsaved ? <Button type="submit" size="sm" disabled={needsWhy && !why.trim()}>Save reason</Button> : null}
        </form>
      ) : null}
    </li>
  );
}

function OpportunityCard({ opportunity, board, run }: { opportunity: DeepDiveOpportunity; board: DeepDiveOpportunityBoard; run: Run }) {
  const builds = deepDiveBuildsFor(board.builds, opportunity.id);
  const [buildName, setBuildName] = useState("");
  // Validated findings can be linked; a finding linked earlier and since superseded stays listed.
  const findingOptions = board.findings
    .filter((finding) => finding.status === "validated" || opportunity.findingIds.includes(finding.id))
    .map((finding) => ({
      id: finding.id,
      label: finding.statement,
      note: finding.status === "validated" ? finding.streamTitle : `${finding.streamTitle} · ${DEEP_DIVE_FINDING_LABELS[finding.status]}`,
    }));

  function addBuild(event: FormEvent) {
    event.preventDefault();
    if (!buildName.trim()) return;
    run(() => deepDiveOpportunitiesApi.addBuild(board.companyId, { name: buildName.trim(), opportunityId: opportunity.id }));
    setBuildName("");
  }

  return (
    <li>
      <Card className="gap-3 px-4 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[12rem] flex-1">
            <h3 className="break-words text-sm font-semibold">{opportunity.ref ? `${opportunity.ref} · ` : ""}{opportunity.name}</h3>
            <p className="text-sm"><span className="text-muted-foreground">Desired outcome: </span>{opportunity.desiredOutcome}</p>
            {opportunity.statement ? <p className="text-xs text-muted-foreground">{opportunity.statement}</p> : null}
            {opportunity.rootCause ? <p className="text-xs text-muted-foreground">Root cause: {opportunity.rootCause}</p> : null}
          </div>
          <NativeSelect
            aria-label={`State of ${opportunity.name}`}
            className="h-8 w-auto text-xs"
            value={opportunity.state}
            onChange={(event) => {
              const state = event.target.value as DeepDiveOpportunityState;
              run(() => deepDiveOpportunitiesApi.updateOpportunity(opportunity.id, { state }));
            }}
          >
            {DEEP_DIVE_OPPORTUNITY_STATES.map((option) => <option key={option} value={option}>{DEEP_DIVE_OPPORTUNITY_STATE_LABELS[option]}</option>)}
          </NativeSelect>
          <VisibilitySelect value={opportunity.visibility} label={`Sharing for ${opportunity.name}`} onChange={(visibility) => run(() => deepDiveOpportunitiesApi.updateOpportunity(opportunity.id, { visibility }))} />
          <RemoveButton label={`Remove ${opportunity.name}`} onClick={() => run(() => deepDiveOpportunitiesApi.removeOpportunity(opportunity.id))} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <LinkList
            legend={`Findings that point at ${opportunity.name} (${opportunity.findingIds.length})`}
            options={findingOptions}
            selected={opportunity.findingIds}
            empty={<>No validated findings yet. <Link to="/deep-dive/findings" className="underline">Validate findings</Link> first.</>}
            onChange={(findingIds) => run(() => deepDiveOpportunitiesApi.updateOpportunity(opportunity.id, { findingIds }))}
          />
          <section className="space-y-1.5" aria-label={`Builds for ${opportunity.name}`}>
            <h4 className="text-xs font-medium text-muted-foreground">Builds ({builds.length})</h4>
            {builds.length > 0 ? (
              <ul className="space-y-1.5">{builds.map((build) => <BuildRow key={build.id} build={build} board={board} run={run} />)}</ul>
            ) : (
              <p className="text-xs text-muted-foreground">No build serves this yet.</p>
            )}
            <form onSubmit={addBuild} className="flex gap-2">
              <Input aria-label={`New build for ${opportunity.name}`} className="h-8 text-xs" placeholder="A build this needs" value={buildName} onChange={(event) => setBuildName(event.target.value)} />
              <Button type="submit" size="sm" disabled={!buildName.trim()}>Add build</Button>
            </form>
          </section>
        </div>
      </Card>
    </li>
  );
}

function KpiCard({ kpi, board, run }: { kpi: DeepDiveKpi; board: DeepDiveOpportunityBoard; run: Run }) {
  const { change, fitsDirection } = deepDiveKpiChange(kpi);
  const unit = kpi.unit ? ` ${kpi.unit}` : "";
  return (
    <li>
      <Card className="gap-2 px-4 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[12rem] flex-1">
            <h3 className="break-words text-sm font-semibold">{kpi.name}</h3>
            <p className="text-xs text-muted-foreground">{SCOPE_LABELS[kpi.scope]} number · {DEEP_DIVE_KPI_DIRECTION_LABELS[kpi.direction]}</p>
          </div>
          <NativeSelect
            aria-label={`Owner of ${kpi.name}`}
            className="h-8 w-auto max-w-[12rem] text-xs"
            value={kpi.ownerPersonId}
            onChange={(event) => {
              const ownerPersonId = event.target.value;
              run(() => deepDiveOpportunitiesApi.updateKpi(kpi.id, { ownerPersonId }));
            }}
          >
            {board.people.map((person) => <option key={person.id} value={person.id}>Owner: {person.name}</option>)}
          </NativeSelect>
          <VisibilitySelect value={kpi.visibility} label={`Sharing for ${kpi.name}`} onChange={(visibility) => run(() => deepDiveOpportunitiesApi.updateKpi(kpi.id, { visibility }))} />
          <RemoveButton label={`Remove ${kpi.name}`} onClick={() => run(() => deepDiveOpportunitiesApi.removeKpi(kpi.id))} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Baseline</dt><dd>{number(kpi.baseline)}{unit}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Target</dt><dd>{number(kpi.target)}{unit}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Period</dt><dd className="break-words">{kpi.baselinePeriod}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Change</dt><dd>{change > 0 ? "+" : ""}{number(change)}{unit}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">How it is calculated: {kpi.definition}</p>
        {!fitsDirection ? (
          <p role="status" className="text-xs text-destructive">The target does not move this number the way it counts as better.</p>
        ) : null}
        <LinkList
          legend={`Processes that move ${kpi.name} (${kpi.processIds.length})`}
          options={board.processes.map((process) => ({ id: process.id, label: process.name }))}
          selected={kpi.processIds}
          empty={<>No processes yet. <Link to="/deep-dive/processes" className="underline">Add them on the process board</Link>.</>}
          onChange={(processIds) => run(() => deepDiveOpportunitiesApi.updateKpi(kpi.id, { processIds }))}
        />
      </Card>
    </li>
  );
}

function AddOpportunity({ board, run, pending }: { board: DeepDiveOpportunityBoard; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState("");
  const [statement, setStatement] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [findingIds, setFindingIds] = useState<string[]>([]);
  const ready = !!name.trim() && !!outcome.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    run(() => deepDiveOpportunitiesApi.addOpportunity(board.companyId, {
      name: name.trim(),
      desiredOutcome: outcome.trim(),
      statement: statement.trim(),
      rootCause: rootCause.trim(),
      findingIds,
    }));
    setName("");
    setOutcome("");
    setStatement("");
    setRootCause("");
    setFindingIds([]);
  }

  return (
    <Card className="gap-2 px-4 py-3">
      <form onSubmit={submit} className="space-y-2" aria-labelledby="deep-dive-add-opportunity">
        <h2 id="deep-dive-add-opportunity" className="text-sm font-semibold">Add an opportunity</h2>
        <div className="grid gap-2 md:grid-cols-2">
          <Input aria-label="Opportunity name" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input aria-label="Desired outcome" placeholder="Desired outcome (needed)" value={outcome} onChange={(event) => setOutcome(event.target.value)} />
          <Textarea aria-label="Where change could create value" placeholder="Where change could create value" rows={2} value={statement} onChange={(event) => setStatement(event.target.value)} />
          <Textarea aria-label="Root cause" placeholder="Root cause" rows={2} value={rootCause} onChange={(event) => setRootCause(event.target.value)} />
        </div>
        <LinkList
          legend="Validated findings that point here"
          options={board.findings.filter((finding) => finding.status === "validated").map((finding) => ({ id: finding.id, label: finding.statement, note: finding.streamTitle }))}
          selected={findingIds}
          empty={<>No validated findings yet. <Link to="/deep-dive/findings" className="underline">Validate findings</Link> first.</>}
          onChange={setFindingIds}
        />
        <Button type="submit" size="sm" disabled={!ready || pending}>Add opportunity</Button>
      </form>
    </Card>
  );
}

function AddKpi({ board, run, pending }: { board: DeepDiveOpportunityBoard; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [scope, setScope] = useState<DeepDiveKpiScope>("company");
  const [direction, setDirection] = useState<DeepDiveKpiDirection>("up");
  const [unit, setUnit] = useState("");
  const [baseline, setBaseline] = useState("");
  const [definition, setDefinition] = useState("");
  const [period, setPeriod] = useState("");
  const [target, setTarget] = useState("");
  const [processIds, setProcessIds] = useState<string[]>([]);
  const asNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
  const ready = !!name.trim() && !!owner && Number.isFinite(asNumber(baseline)) && Number.isFinite(asNumber(target))
    && !!definition.trim() && !!period.trim();

  if (board.people.length === 0) {
    return (
      <Card className="gap-1 px-4 py-3">
        <h2 className="text-sm font-semibold">Add a KPI</h2>
        <p className="text-sm text-muted-foreground">
          A KPI needs an owner. <Link to="/deep-dive/organisation" className="underline">Add people on the organisation board</Link> first.
        </p>
      </Card>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    run(() => deepDiveOpportunitiesApi.addKpi(board.companyId, {
      name: name.trim(),
      ownerPersonId: owner,
      scope,
      direction,
      unit: unit.trim(),
      baseline: asNumber(baseline),
      definition: definition.trim(),
      baselinePeriod: period.trim(),
      target: asNumber(target),
      processIds,
    }));
    setName("");
    setBaseline("");
    setTarget("");
    setDefinition("");
    setPeriod("");
    setProcessIds([]);
  }

  return (
    <Card className="gap-2 px-4 py-3">
      <form onSubmit={submit} className="space-y-2" aria-labelledby="deep-dive-add-kpi">
        <h2 id="deep-dive-add-kpi" className="text-sm font-semibold">Add a KPI</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input aria-label="KPI name" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <NativeSelect aria-label="KPI owner" value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">Owner (needed)</option>
            {board.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="KPI scope" value={scope} onChange={(event) => setScope(event.target.value as DeepDiveKpiScope)}>
            {DEEP_DIVE_KPI_SCOPES.map((option) => <option key={option} value={option}>{SCOPE_LABELS[option]} number</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Which way is better" value={direction} onChange={(event) => setDirection(event.target.value as DeepDiveKpiDirection)}>
            {DEEP_DIVE_KPI_DIRECTIONS.map((option) => <option key={option} value={option}>{DEEP_DIVE_KPI_DIRECTION_LABELS[option]}</option>)}
          </NativeSelect>
          <Input aria-label="Baseline" inputMode="decimal" placeholder="Baseline (needed)" value={baseline} onChange={(event) => setBaseline(event.target.value)} />
          <Input aria-label="Target" inputMode="decimal" placeholder="Target (needed)" value={target} onChange={(event) => setTarget(event.target.value)} />
          <Input aria-label="Unit of measure" placeholder="Unit, e.g. days" value={unit} onChange={(event) => setUnit(event.target.value)} />
          <Input aria-label="Period the baseline covers" placeholder="Period, e.g. Q3 2026 (needed)" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </div>
        <Textarea aria-label="How it is calculated" placeholder="How it is calculated (needed)" rows={2} value={definition} onChange={(event) => setDefinition(event.target.value)} />
        <LinkList
          legend="Processes that move it"
          options={board.processes.map((process) => ({ id: process.id, label: process.name }))}
          selected={processIds}
          empty={<>No processes yet. <Link to="/deep-dive/processes" className="underline">Add them on the process board</Link>.</>}
          onChange={setProcessIds}
        />
        <Button type="submit" size="sm" disabled={!ready || pending}>Add KPI</Button>
      </form>
    </Card>
  );
}

export function DeepDiveOpportunities() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Opportunities and KPIs" }]);
  }, [setBreadcrumbs]);

  const boardQuery = useQuery({
    queryKey: deepDiveOpportunitiesQueryKeys.board(companyId),
    queryFn: () => deepDiveOpportunitiesApi.get(companyId),
    enabled: !!selectedCompanyId,
  });
  const writeMutation = useMutation({
    mutationFn: (write: () => Promise<DeepDiveOpportunityBoard>) => write(),
    onSuccess: (board) => queryClient.setQueryData(deepDiveOpportunitiesQueryKeys.board(companyId), board),
  });
  const run: Run = (write) => writeMutation.mutate(write);

  if (!selectedCompanyId) return <EmptyState icon={Target} message="Select a company to see its opportunities and KPIs." />;
  if (boardQuery.isLoading) return <PageSkeleton variant="list" />;
  if (boardQuery.error || !boardQuery.data) return <p className="text-sm text-destructive">{errorText(boardQuery.error) ?? "The board did not load."}</p>;

  const board = boardQuery.data;
  const gaps = deepDiveOpportunityGaps(board);
  const loose = gaps.buildsServingNothing;
  const writeError = errorText(writeMutation.error);
  const gapLines = [
    gaps.opportunitiesWithNoFinding.length
      ? `${count(gaps.opportunitiesWithNoFinding.length, "opportunity rests", "opportunities rest")} on no validated finding` : null,
    gaps.opportunitiesWithNoBuild.length
      ? `${count(gaps.opportunitiesWithNoBuild.length, "opportunity has", "opportunities have")} no build` : null,
    loose.length ? `${count(loose.length, "build serves", "builds serve")} no opportunity` : null,
    gaps.kpisMovedByNoProcess.length
      ? `${count(gaps.kpisMovedByNoProcess.length, "KPI is", "KPIs are")} moved by no process` : null,
  ].filter((line): line is string => !!line);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Opportunities and KPIs</h1>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Link to="/deep-dive/findings" className="text-xs font-medium underline-offset-4 hover:underline">Findings</Link>
            <Link to="/deep-dive/processes" className="text-xs font-medium underline-offset-4 hover:underline">Process board</Link>
            <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">Back to the Deep Dive</Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Many validated findings point at one opportunity, and one opportunity needs many builds. A KPI belongs to a
          person, has a baseline and a target, and names the processes that move it. Everything starts Internal.
        </p>
      </header>

      {writeError ? <p role="alert" className="text-sm text-destructive">{writeError}</p> : null}
      {gapLines.length > 0 ? (
        <ul aria-label="Still to do" className="list-inside list-disc text-xs text-muted-foreground">
          {gapLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}

      <section aria-labelledby="deep-dive-opportunities" className="space-y-2">
        <h2 id="deep-dive-opportunities" className="text-base font-semibold">Opportunities ({board.opportunities.length})</h2>
        <AddOpportunity board={board} run={run} pending={writeMutation.isPending} />
        {board.opportunities.length > 0 ? (
          <ul className="space-y-2">
            {board.opportunities.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} board={board} run={run} />)}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No opportunities yet.</p>
        )}
        {loose.length > 0 ? (
          <section aria-labelledby="deep-dive-loose-builds" className="space-y-1.5">
            <h3 id="deep-dive-loose-builds" className="text-sm font-semibold">Builds that serve no opportunity ({loose.length})</h3>
            <ul className="space-y-1.5">{loose.map((build) => <BuildRow key={build.id} build={build} board={board} run={run} />)}</ul>
          </section>
        ) : null}
      </section>

      <section aria-labelledby="deep-dive-kpis" className="space-y-2">
        <h2 id="deep-dive-kpis" className="text-base font-semibold">KPIs ({board.kpis.length})</h2>
        <AddKpi board={board} run={run} pending={writeMutation.isPending} />
        {board.kpis.length > 0 ? (
          <ul className="grid gap-2 lg:grid-cols-2">{board.kpis.map((kpi) => <KpiCard key={kpi.id} kpi={kpi} board={board} run={run} />)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">No KPIs yet. Ask each stakeholder what they are measured by.</p>
        )}
      </section>
    </div>
  );
}
