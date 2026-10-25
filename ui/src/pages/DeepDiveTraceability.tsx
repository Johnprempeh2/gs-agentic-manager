import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import {
  DEEP_DIVE_CHAIN_STEPS,
  DEEP_DIVE_CHAIN_STEP_LABELS,
  DEEP_DIVE_DESIGN_STATES_OUT_OF_CHAIN,
  deepDiveChains,
  type DeepDiveChain,
  type DeepDiveCommercial,
  type DeepDiveRoadmapItem,
  type DeepDiveTraceability,
} from "@greatstone/shared";
import { deepDiveTraceabilityApi, deepDiveTraceabilityQueryKeys } from "@/api/deepDiveTraceability";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { LinkList, RemoveButton, VisibilitySelect } from "./DeepDiveOpportunities";

// Deep Dive traceability (GRE-2371): Screen 8 of the GRE-2327 plan, from
// Indago, made stronger. Each opportunity's chain North Star → Source →
// Finding → Opportunity → Design → Commercial → Roadmap → KPI, read from real
// links, with the place it breaks marked; the server's broken-link check is
// listed above. Commercial cases and roadmap items are added here; every
// other step is added on its own screen.

type Run = (write: () => Promise<DeepDiveTraceability>) => void;

/** Where to add the item a step is missing. */
const STEP_HOME: Partial<Record<(typeof DEEP_DIVE_CHAIN_STEPS)[number], { to: string; label: string }>> = {
  north_star: { to: "/deep-dive", label: "Deep Dive record" },
  source: { to: "/deep-dive/findings", label: "Findings" },
  finding: { to: "/deep-dive/opportunities", label: "Opportunities" },
  opportunity: { to: "/deep-dive/opportunities", label: "Opportunities" },
  design: { to: "/deep-dive/opportunities", label: "Opportunities" },
  kpi: { to: "/deep-dive/opportunities", label: "KPIs" },
};

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function ChainCard({ chain }: { chain: DeepDiveChain }) {
  const breakAt = DEEP_DIVE_CHAIN_STEPS.find((step) => chain.steps[step].length === 0) ?? null;
  return (
    <li>
      <Card className="gap-2 px-4 py-3" aria-label={`Chain through ${chain.opportunity.name}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="break-words text-sm font-semibold">{chain.opportunity.name}</h3>
          <span className={cn("text-xs", breakAt ? "text-destructive" : "text-muted-foreground")}>
            {breakAt ? `Breaks at ${DEEP_DIVE_CHAIN_STEP_LABELS[breakAt]}` : "Whole chain"}
          </span>
        </div>
        <ol className="space-y-1">
          {DEEP_DIVE_CHAIN_STEPS.map((step) => {
            const items = chain.steps[step];
            const isBreak = step === breakAt;
            return (
              <li
                key={step}
                data-chain-step={step}
                className={cn("grid grid-cols-[6.5rem_1fr] gap-2 border-l-2 pl-2 text-sm", isBreak ? "border-destructive" : "border-border")}
              >
                <span className="text-xs font-medium text-muted-foreground">{DEEP_DIVE_CHAIN_STEP_LABELS[step]}</span>
                {items.length > 0 ? (
                  <span className="min-w-0 break-words">{items.map((item) => item.name).join(" · ")}</span>
                ) : (
                  <span className={cn("text-xs", isBreak ? "font-medium text-destructive" : "text-muted-foreground")}>
                    {isBreak ? "Breaks here: nothing linked" : "Not reached"}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </li>
  );
}

function CommercialRow({ commercial, chain, run }: { commercial: DeepDiveCommercial; chain: DeepDiveTraceability; run: Run }) {
  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[10rem] flex-1 break-words text-sm font-medium">{commercial.name}</span>
        <NativeSelect
          aria-label={`Design ${commercial.name} is for`}
          className="h-8 w-auto max-w-[14rem] text-xs"
          value={commercial.buildId ?? ""}
          onChange={(event) => {
            const buildId = event.target.value || null;
            run(() => deepDiveTraceabilityApi.updateCommercial(commercial.id, { buildId }));
          }}
        >
          <option value="">For no design</option>
          {chain.designs.map((design) => <option key={design.id} value={design.id}>For {design.name}</option>)}
        </NativeSelect>
        <VisibilitySelect value={commercial.visibility} label={`Sharing for ${commercial.name}`} onChange={(visibility) => run(() => deepDiveTraceabilityApi.updateCommercial(commercial.id, { visibility }))} />
        <RemoveButton label={`Remove ${commercial.name}`} onClick={() => run(() => deepDiveTraceabilityApi.removeCommercial(commercial.id))} />
      </div>
      {commercial.terms ? <p className="text-xs text-muted-foreground">{commercial.terms}</p> : null}
    </li>
  );
}

function RoadmapRow({ item, chain, run }: { item: DeepDiveRoadmapItem; chain: DeepDiveTraceability; run: Run }) {
  return (
    <li className="space-y-1.5 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[10rem] flex-1 break-words text-sm font-medium">
          {item.name}{item.phase ? <span className="text-xs text-muted-foreground"> · {item.phase}</span> : null}
        </span>
        <NativeSelect
          aria-label={`Commercial case ${item.name} delivers`}
          className="h-8 w-auto max-w-[14rem] text-xs"
          value={item.commercialId ?? ""}
          onChange={(event) => {
            const commercialId = event.target.value || null;
            run(() => deepDiveTraceabilityApi.updateRoadmapItem(item.id, { commercialId }));
          }}
        >
          <option value="">Delivers no commercial case</option>
          {chain.commercials.map((commercial) => <option key={commercial.id} value={commercial.id}>Delivers {commercial.name}</option>)}
        </NativeSelect>
        <VisibilitySelect value={item.visibility} label={`Sharing for ${item.name}`} onChange={(visibility) => run(() => deepDiveTraceabilityApi.updateRoadmapItem(item.id, { visibility }))} />
        <RemoveButton label={`Remove ${item.name}`} onClick={() => run(() => deepDiveTraceabilityApi.removeRoadmapItem(item.id))} />
      </div>
      <LinkList
        legend={`KPIs ${item.name} moves (${item.kpiIds.length})`}
        options={chain.kpis.map((kpi) => ({ id: kpi.id, label: kpi.name }))}
        selected={item.kpiIds}
        empty={<>No KPIs yet. <Link to="/deep-dive/opportunities" className="underline">Add KPIs</Link> first.</>}
        onChange={(kpiIds) => run(() => deepDiveTraceabilityApi.updateRoadmapItem(item.id, { kpiIds }))}
      />
    </li>
  );
}

function AddCommercial({ chain, run, pending }: { chain: DeepDiveTraceability; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [buildId, setBuildId] = useState("");
  const [terms, setTerms] = useState("");
  const designs = chain.designs.filter((design) => !DEEP_DIVE_DESIGN_STATES_OUT_OF_CHAIN.has(design.state));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    run(() => deepDiveTraceabilityApi.addCommercial(chain.companyId, { name: name.trim(), buildId: buildId || null, terms: terms.trim() }));
    setName("");
    setBuildId("");
    setTerms("");
  }

  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" aria-label="Add a commercial case">
      <Input aria-label="Commercial case name" className="h-8 text-xs" placeholder="Name, e.g. Fixed fee build" value={name} onChange={(event) => setName(event.target.value)} />
      <NativeSelect aria-label="Design it is for" className="h-8 text-xs" value={buildId} onChange={(event) => setBuildId(event.target.value)}>
        <option value="">For which design?</option>
        {designs.map((design) => <option key={design.id} value={design.id}>{design.name}</option>)}
      </NativeSelect>
      <Input aria-label="Terms" className="h-8 text-xs" placeholder="What it costs and how it is paid" value={terms} onChange={(event) => setTerms(event.target.value)} />
      <Button type="submit" size="sm" disabled={!name.trim() || pending}>Add commercial case</Button>
    </form>
  );
}

function AddRoadmapItem({ chain, run, pending }: { chain: DeepDiveTraceability; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState("");
  const [commercialId, setCommercialId] = useState("");
  const [kpiIds, setKpiIds] = useState<string[]>([]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    run(() => deepDiveTraceabilityApi.addRoadmapItem(chain.companyId, {
      name: name.trim(),
      phase: phase.trim(),
      commercialId: commercialId || null,
      kpiIds,
    }));
    setName("");
    setPhase("");
    setCommercialId("");
    setKpiIds([]);
  }

  return (
    <form onSubmit={submit} className="space-y-2" aria-label="Add a roadmap item">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <Input aria-label="Roadmap item name" className="h-8 text-xs" placeholder="Name, e.g. Phase 1 build" value={name} onChange={(event) => setName(event.target.value)} />
        <Input aria-label="When" className="h-8 text-xs" placeholder="When, e.g. Q1 2027" value={phase} onChange={(event) => setPhase(event.target.value)} />
        <NativeSelect aria-label="Commercial case it delivers" className="h-8 text-xs" value={commercialId} onChange={(event) => setCommercialId(event.target.value)}>
          <option value="">Delivers which commercial case?</option>
          {chain.commercials.map((commercial) => <option key={commercial.id} value={commercial.id}>{commercial.name}</option>)}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={!name.trim() || pending}>Add roadmap item</Button>
      </div>
      <LinkList
        legend="KPIs it moves"
        options={chain.kpis.map((kpi) => ({ id: kpi.id, label: kpi.name }))}
        selected={kpiIds}
        empty={<>No KPIs yet. <Link to="/deep-dive/opportunities" className="underline">Add KPIs</Link> first.</>}
        onChange={setKpiIds}
      />
    </form>
  );
}

export function DeepDiveTraceability() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Traceability" }]);
  }, [setBreadcrumbs]);

  const chainQuery = useQuery({
    queryKey: deepDiveTraceabilityQueryKeys.chain(companyId),
    queryFn: () => deepDiveTraceabilityApi.get(companyId),
    enabled: !!selectedCompanyId,
  });
  const writeMutation = useMutation({
    mutationFn: (write: () => Promise<DeepDiveTraceability>) => write(),
    onSuccess: (chain) => queryClient.setQueryData(deepDiveTraceabilityQueryKeys.chain(companyId), chain),
  });
  const run: Run = (write) => writeMutation.mutate(write);

  if (!selectedCompanyId) return <EmptyState icon={Route} message="Select a company to see its traceability chain." />;
  if (chainQuery.isLoading) return <PageSkeleton variant="list" />;
  if (chainQuery.error || !chainQuery.data) return <p className="text-sm text-destructive">{errorText(chainQuery.error) ?? "The chain did not load."}</p>;

  const chain = chainQuery.data;
  const chains = deepDiveChains(chain);
  const writeError = errorText(writeMutation.error);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Traceability</h1>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Link to="/deep-dive/findings" className="text-xs font-medium underline-offset-4 hover:underline">Findings</Link>
            <Link to="/deep-dive/opportunities" className="text-xs font-medium underline-offset-4 hover:underline">Opportunities and KPIs</Link>
            <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">Back to the Deep Dive</Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {DEEP_DIVE_CHAIN_STEPS.map((step) => DEEP_DIVE_CHAIN_STEP_LABELS[step]).join(" → ")}. Every step is a saved
          link, not a typed reference. A chain breaks where a step has nothing linked. Everything starts Internal.
        </p>
      </header>

      {writeError ? <p role="alert" className="text-sm text-destructive">{writeError}</p> : null}

      <section aria-labelledby="deep-dive-broken-links" className="space-y-2">
        <h2 id="deep-dive-broken-links" className="text-base font-semibold">Broken links ({chain.broken.length})</h2>
        {chain.broken.length > 0 ? (
          <ul aria-label="Broken links" className="space-y-1">
            {chain.broken.map((link) => {
              const home = STEP_HOME[link.missing];
              return (
                <li key={`${link.step}:${link.itemId ?? "none"}:${link.missing}`} className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
                  <span className="text-xs font-medium text-destructive">
                    {DEEP_DIVE_CHAIN_STEP_LABELS[link.step]} → {DEEP_DIVE_CHAIN_STEP_LABELS[link.missing]}
                  </span>{" "}
                  {link.itemId ? <span className="font-medium">{link.itemName}: </span> : null}
                  {link.message}
                  {home ? <> <Link to={home.to} className="text-xs underline">{home.label}</Link></> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {chain.opportunities.length > 0 ? "No broken links. Every chain runs from the North Star to a KPI." : "No broken links."}
          </p>
        )}
      </section>

      <section aria-labelledby="deep-dive-chains" className="space-y-2">
        <h2 id="deep-dive-chains" className="text-base font-semibold">Chains ({chains.length})</h2>
        {chains.length > 0 ? (
          <ul className="grid gap-2 lg:grid-cols-2">{chains.map((entry) => <ChainCard key={entry.opportunity.id} chain={entry} />)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No opportunities yet, so there is no chain. <Link to="/deep-dive/opportunities" className="underline">Add an opportunity</Link>.
          </p>
        )}
      </section>

      <section aria-labelledby="deep-dive-commercials" className="space-y-2">
        <h2 id="deep-dive-commercials" className="text-base font-semibold">Commercial cases ({chain.commercials.length})</h2>
        <AddCommercial chain={chain} run={run} pending={writeMutation.isPending} />
        {chain.commercials.length > 0 ? (
          <ul className="space-y-1.5">{chain.commercials.map((commercial) => <CommercialRow key={commercial.id} commercial={commercial} chain={chain} run={run} />)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">No commercial cases yet.</p>
        )}
      </section>

      <section aria-labelledby="deep-dive-roadmap" className="space-y-2">
        <h2 id="deep-dive-roadmap" className="text-base font-semibold">Roadmap ({chain.roadmap.length})</h2>
        <AddRoadmapItem chain={chain} run={run} pending={writeMutation.isPending} />
        {chain.roadmap.length > 0 ? (
          <ul className="space-y-1.5">{chain.roadmap.map((item) => <RoadmapRow key={item.id} item={item} chain={chain} run={run} />)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">No roadmap items yet.</p>
        )}
      </section>
    </div>
  );
}
