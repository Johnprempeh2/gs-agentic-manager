import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Microscope } from "lucide-react";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_GIF,
  DEEP_DIVE_STREAMS,
  deepDiveGifStubBody,
  deepDiveStreamCaseKey,
  defaultDeepDiveStreamFields,
  type DeepDiveStartableClient,
} from "@greatstone/shared";
import { ApiError } from "@/api/client";
import { casesApi } from "@/api/cases";
import { deepDiveRecordsApi, deepDiveRecordsQueryKeys } from "@/api/deepDiveRecords";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { deepDivePath } from "@/lib/deep-dive-scope";
import { useNavigate, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { DeepDiveTile } from "@/components/DeepDiveTile";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 sm:w-auto";

/**
 * Start one client's Deep Dive (GRE-4430): the record case for the client,
 * and the nine stream cases with their cells, which the findings and sessions
 * still file under (the streams are tags; Ben's workstreams group the work).
 */
export async function startDeepDive(companyId: string, client: Pick<DeepDiveStartableClient, "id" | "name">) {
  const record = await casesApi.create(companyId, {
    caseType: DEEP_DIVE_CASE_TYPES.record,
    key: `deep-dive:${crypto.randomUUID()}`,
    title: `Deep Dive: ${client.name}`,
    clientCaseId: client.id,
    fields: { workstreams: [], status: "active" },
  });
  for (const stream of DEEP_DIVE_STREAMS) {
    const detail = await casesApi.create(companyId, {
      caseType: DEEP_DIVE_CASE_TYPES.stream,
      key: deepDiveStreamCaseKey(record.id, stream.key),
      title: `${client.name}: ${stream.label}`,
      parentCaseId: record.id,
      fields: { ...defaultDeepDiveStreamFields(stream.key) },
    });
    for (const gif of DEEP_DIVE_GIF) {
      try {
        await casesApi.upsertDocument(detail.id, gif.documentKey, { title: gif.label, format: "markdown", body: deepDiveGifStubBody(gif) });
      } catch (error) {
        // 409: the document appeared meanwhile. It exists, which is all we need.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
    }
  }
  return record;
}

/** Every client's Deep Dive, one tile each; "Start a Deep Dive" makes a new one. */
export function DeepDiveTiles() {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [starting, setStarting] = useState(searchParams.has("start"));
  const [clientId, setClientId] = useState(searchParams.get("start") ?? "");
  const [showFinished, setShowFinished] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: "Deep Dive" }]), [setBreadcrumbs]);

  const list = useQuery({
    queryKey: deepDiveRecordsQueryKeys.list(companyId),
    queryFn: () => deepDiveRecordsApi.list(companyId),
    enabled: !!companyId,
  });
  const start = useMutation({
    mutationFn: (client: DeepDiveStartableClient) => startDeepDive(companyId, client),
    onSuccess: async (record) => {
      await queryClient.invalidateQueries({ queryKey: deepDiveRecordsQueryKeys.list(companyId) });
      navigate(deepDivePath(record.id));
    },
  });

  // What needs a person first, then the newest.
  const tiles = useMemo(() => {
    const all = list.data?.deepDives ?? [];
    return all
      .filter((record) => showFinished || record.status === "active")
      .sort((a, b) => b.draftsWaiting + b.findingsToValidate - (a.draftsWaiting + a.findingsToValidate) || b.createdAt.localeCompare(a.createdAt));
  }, [list.data, showFinished]);

  if (!companyId) return <EmptyState icon={Microscope} message="Select a company to see its Deep Dives." />;
  if (list.isLoading) return <PageSkeleton variant="list" />;
  if (list.error || !list.data) {
    return <p role="alert" className="text-sm text-destructive">{list.error instanceof Error ? list.error.message : "Could not load the Deep Dives."}</p>;
  }

  const clients = list.data.clients;
  const chosen = clients.find((client) => client.id === clientId) ?? null;
  const finishedCount = list.data.deepDives.filter((record) => record.status === "finished").length;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen) start.mutate(chosen);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">Deep Dive</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            One Deep Dive for each client engagement. Open a tile for its questions and answers, findings, sessions,
            documents and deliverables.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {finishedCount > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowFinished((v) => !v)} aria-pressed={showFinished}>
              {showFinished ? "Hide finished" : `Show finished (${finishedCount})`}
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => setStarting(true)} data-tour="deep-dive-start">Start a Deep Dive</Button>
        </div>
      </header>

      {starting ? (
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="start-deep-dive">
          <h2 id="start-deep-dive" className="text-sm font-semibold">Start a Deep Dive</h2>
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground">No client engagement is open yet. Add the client under Clients first.</p>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Client</span>
                <select className={SELECT_CLASS} value={clientId} onChange={(event) => setClientId(event.target.value)} required>
                  <option value="">Choose the client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name} ({client.stageName})
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                Clients whose engagement is at the Deep Dive stage are listed first. A client can have more than one
                Deep Dive over time.
              </p>
            </>
          )}
          {start.error ? (
            <p role="alert" className="text-sm text-destructive">{start.error instanceof Error ? start.error.message : "Could not start the Deep Dive."}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!chosen || start.isPending}>{start.isPending ? "Starting..." : "Start"}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStarting(false)} disabled={start.isPending}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {tiles.length === 0 ? (
        <EmptyState icon={Microscope} message={showFinished ? "No Deep Dives yet." : "No Deep Dive is running. Start one for a client."} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Deep Dives" data-tour="deep-dive-tiles">
          {tiles.map((record) => (
            <li key={record.id}>
              <DeepDiveTile record={record} to={deepDivePath(record.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
