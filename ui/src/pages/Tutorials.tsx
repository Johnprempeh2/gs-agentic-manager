import { useEffect, useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { pipelinesApi } from "@/api/pipelines";
import { teamChatsApi } from "@/api/teamChats";
import { toolsApi } from "@/api/tools";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useTourSeen } from "@/hooks/useTourSeen";
import { CLIENT_CASE_TYPE } from "@/lib/client-case";
import { ALL_TOURS, type TourDefinition } from "@/lib/feature-tours";
import { GLOSSARY } from "@/lib/glossary";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { agentUrl } from "@/lib/utils";

/** The four tours a new person should take first, in order. */
export const START_HERE_TOUR_IDS = ["needed", "decisions", "tasks", "agents"] as const;

type StartTarget = { path: string } | { nothing: string };

/** Where each tour runs. Tours about one item open the first one there is. */
async function resolveStart(tour: TourDefinition, companyId: string): Promise<StartTarget> {
  if (tour.id === "task-detail") {
    const [first] = await issuesApi.list(companyId, { limit: 1 });
    return first ? { path: `/issues/${first.identifier ?? first.id}` } : { nothing: "There are no tasks yet. Start one with New Task first." };
  }
  if (tour.id === "agent-detail") {
    const [first] = await agentsApi.list(companyId);
    return first ? { path: agentUrl(first) } : { nothing: "There are no agents yet. Hire one first." };
  }
  if (tour.route) return { path: tour.route.path };
  const tourId = tour.id;
  switch (tourId) {
    case "pipelines-list":
      return { path: "/pipelines" };
    case "strategy-board":
      return { path: "/strategy-board" };
    case "website":
      // The tour points at the traffic report, which no longer opens first.
      return { path: "/website?tab=traffic" };
    case "pipeline-board":
    case "client-case": {
      const pipelines = (await pipelinesApi.list(companyId)).filter((pipeline) => !pipeline.archivedAt);
      if (tourId === "pipeline-board") {
        return pipelines[0] ? { path: `/pipelines/${pipelines[0].id}` } : { nothing: "There are no pipelines yet. Create one first." };
      }
      const clients = pipelines.find((pipeline) => pipeline.key === CLIENT_CASE_TYPE);
      const first = clients ? (await pipelinesApi.listCases(clients.id))[0] : undefined;
      return first
        ? { path: `/pipelines/${clients!.id}/items/${first.case.id}` }
        : { nothing: "There are no clients yet. Add a client first." };
    }
    case "github-share-with-agents": {
      const { connections } = await toolsApi.listConnections(companyId);
      const github = connections.find((connection) => connection.config?.sourceTemplateKey === "github");
      return github ? { path: `/apps/${github.id}/permissions` } : { nothing: "GitHub is not connected yet. Connect it in Apps first." };
    }
    case "team-chat": {
      const [first] = await teamChatsApi.list(companyId);
      return first ? { path: `/messages/${first.id}` } : { nothing: "You are in no chats yet. Start one from the sidebar first." };
    }
    default:
      return { nothing: "This tour has no page to open." };
  }
}

/** Every guided tour in one place: start any of them, or show them all again. */
export function Tutorials() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const { isSeen, resetAll, loading } = useTourSeen();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [resetState, setResetState] = useState<"idle" | "pending" | "done" | "failed">("idle");

  const { hash } = useLocation();

  useEffect(() => {
    setBreadcrumbs([{ label: "Tutorials" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (hash === "#words") document.getElementById("words")?.scrollIntoView({ block: "start" });
  }, [hash]);

  const { data: settings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const tours = ALL_TOURS.filter((tour) => !tour.flag || settings?.[tour.flag] === true);

  async function start(tour: TourDefinition) {
    if (!selectedCompanyId) return;
    setBusy(tour.id);
    setNotes((current) => ({ ...current, [tour.id]: "" }));
    try {
      const target = await resolveStart(tour, selectedCompanyId);
      if ("path" in target) navigate(`${target.path}?tour=${tour.id}`);
      else setNotes((current) => ({ ...current, [tour.id]: target.nothing }));
    } catch {
      setNotes((current) => ({ ...current, [tour.id]: "Could not open this tour. Try again in a moment." }));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setResetState("pending");
    try {
      await resetAll();
      setResetState("done");
    } catch {
      setResetState("failed");
    }
  }

  return (
    <div className="w-full max-w-3xl space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          {/* The page bar already says Tutorials; the line says what it is for. */}
          <p className="text-sm text-muted-foreground">Short guided tours of each page. Start one at any time, or select Show me around at the top of a page.</p>
        </div>
        {tours.length > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={reset} disabled={resetState === "pending"}>
            Show all tutorials again
          </Button>
        ) : null}
      </header>
      <p role="status" className="text-sm text-muted-foreground">
        {resetState === "done" ? "Every tutorial will open again the next time you visit its page." : null}
        {resetState === "failed" ? "Could not reset your tutorials. Try again in a moment." : null}
      </p>
      {(() => {
        const firstSteps = START_HERE_TOUR_IDS
          .map((id) => tours.find((tour) => tour.id === id))
          .filter((tour): tour is TourDefinition => !!tour);
        if (loading || firstSteps.length === 0) return null;
        const done = firstSteps.filter((tour) => isSeen(tour)).length;
        const next = firstSteps.find((tour) => !isSeen(tour));
        return (
          <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="start-here-title" data-testid="tutorials-start-here">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-0.5">
                <h2 id="start-here-title" className="text-sm font-semibold text-foreground">Start here</h2>
                <p className="text-sm text-muted-foreground">
                  {next
                    ? `Four short tours cover the everyday pages. ${done} of ${firstSteps.length} done.`
                    : "You have taken the first four tours. The rest are below whenever you need them."}
                </p>
              </div>
              {next ? (
                <Button type="button" size="sm" onClick={() => start(next)} disabled={busy !== null || !selectedCompanyId}>
                  {done === 0 ? `Begin with ${next.title}` : `Next: ${next.title}`}
                </Button>
              ) : null}
            </div>
            <ol className="grid gap-2 sm:grid-cols-2" aria-label="First tours">
              {firstSteps.map((tour, index) => {
                const seen = isSeen(tour) === true;
                const Icon = seen ? CheckCircle2 : Circle;
                return (
                  <li key={tour.id} className="flex items-center gap-2 text-sm">
                    <Icon className={seen ? "size-4 shrink-0 text-foreground" : "size-4 shrink-0 text-muted-foreground"} aria-hidden="true" />
                    <span className={seen ? "text-muted-foreground" : "text-foreground"}>
                      {index + 1}. {tour.title}
                    </span>
                    <span className="sr-only">{seen ? "(done)" : "(not done yet)"}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })()}
      {isFetched && tours.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tutorials yet. They appear here when their features are switched on.</p>
      ) : (
        [
          { label: "Everyday pages", note: "Short tours of the pages you will use most. Each one takes under a minute.", list: tours.filter((tour) => tour.route) },
          { label: "Features", note: "Tours of the features your organisation has switched on.", list: tours.filter((tour) => !tour.route) },
        ].filter((group) => group.list.length > 0).map((group) => (
          <section key={group.label} className="space-y-2" aria-label={group.label}>
            <div className="space-y-0.5">
              <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
              <p className="text-sm text-muted-foreground">{group.note}</p>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border" aria-label={`${group.label} tutorials`}>
              {group.list.map((tour) => {
                const seen = isSeen(tour);
                return (
                  <li key={tour.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`tutorial-${tour.id}`}>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{tour.title}</h3>
                        {loading ? null : <Badge variant={seen ? "secondary" : "outline"}>{seen ? "Seen" : "Not seen yet"}</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground">{tour.description}</p>
                      <p role="status" className="text-sm text-foreground empty:hidden">{notes[tour.id]}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => start(tour)}
                      disabled={busy !== null || !selectedCompanyId}
                      aria-label={`Start the ${tour.title} tutorial`}
                    >
                      Start
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <section id="words" className="scroll-mt-4 space-y-2" aria-labelledby="words-title">
        <div className="space-y-0.5">
          <h2 id="words-title" className="text-sm font-semibold text-foreground">Words we use</h2>
          <p className="text-sm text-muted-foreground">What each word means here, in plain words. Words with a dotted line elsewhere in the app link to these.</p>
        </div>
        <dl className="divide-y divide-border rounded-lg border border-border">
          {GLOSSARY.map((entry) => (
            <div key={entry.id} id={`word-${entry.id}`} className="space-y-1 p-4">
              <dt className="text-sm font-semibold text-foreground">{entry.term}</dt>
              <dd className="text-sm text-muted-foreground">{entry.plain}</dd>
              {entry.example ? <dd className="text-sm text-muted-foreground">For example: {entry.example}</dd> : null}
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
