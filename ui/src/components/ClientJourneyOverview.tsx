import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, Hourglass } from "lucide-react";
import type { ClientEvidenceItem, ClientJourneyResponse } from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

// The client's journey at a glance (John, 15 Oct): every stage, what is done,
// what is waiting and on whom, and the documents collected at each stage. It
// reads the same journey and files as "Journey by stage" below it, so it
// needs no extra request and never disagrees with the detail.

export type WaitingOn = "client" | "us";

export interface OverviewWait {
  on: WaitingOn;
  text: string;
}

export interface OverviewDocument {
  key: string;
  title: string;
  href: string | null;
}

export interface OverviewStage {
  id: string;
  name: string;
  state: "done" | "current";
  done: string[];
  waiting: OverviewWait[];
  documents: OverviewDocument[];
}

export interface JourneyOverview {
  agreements: { done: string[]; waiting: OverviewWait[] };
  stages: OverviewStage[];
  upcoming: string[];
  waitingOnClient: number;
  waitingOnUs: number;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function listNames(names: string[], max = 3) {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Turn the journey and the client's files into the at-a-glance view. */
export function buildJourneyOverview(
  journey: Pick<ClientJourneyResponse, "nda" | "ndaAcceptedAt" | "engagement" | "stages">,
  evidence: Pick<ClientEvidenceItem, "id" | "stageId" | "title" | "openPath">[],
): JourneyOverview {
  const agreements: JourneyOverview["agreements"] = { done: [], waiting: [] };
  const ndaStatus = journey.nda?.status ?? (journey.ndaAcceptedAt ? "accepted" : "required");
  if (ndaStatus === "accepted") agreements.done.push("NDA accepted");
  else if (ndaStatus === "suspended") agreements.done.push("NDA suspended");
  else agreements.waiting.push({ on: "client", text: "Sign the NDA" });

  const engagement = journey.engagement?.status ?? "not_sent";
  if (engagement === "accepted") agreements.done.push("Engagement pack accepted");
  else if (engagement === "sent") agreements.waiting.push({ on: "client", text: "Accept the engagement pack" });
  else if (ndaStatus !== "required") agreements.waiting.push({ on: "us", text: "Send the engagement pack" });

  const stages: OverviewStage[] = [];
  const upcoming: string[] = [];
  for (const stage of journey.stages) {
    if (stage.state === "side") continue;
    if (stage.state === "next") {
      upcoming.push(stage.name);
      continue;
    }
    const requests = stage.requests ?? [];
    const received = requests.filter((request) => request.received);
    const outstanding = requests.filter((request) => !request.received);
    const missing = stage.expected.filter((item) => !item.deliverableId);
    const filed = stage.deliverables.length;

    const done: string[] = [];
    if (received.length > 0) done.push(`${received.length} of ${plural(requests.length, "document")} received`);
    if (filed > 0) done.push(`${plural(filed, "deliverable")} filed`);

    const waiting: OverviewWait[] = [];
    if (outstanding.length > 0) {
      waiting.push({ on: "client", text: `Send ${listNames(outstanding.map((request) => request.title))}` });
    }
    if (missing.length > 0) {
      waiting.push({ on: "us", text: `Deliver ${listNames(missing.map((item) => item.title))}` });
    }

    // Received requests first (they name what was asked for), then other uploads on the stage.
    const documents: OverviewDocument[] = [];
    const seen = new Set<string>();
    for (const request of received) {
      seen.add(request.received!.evidenceId);
      documents.push({ key: request.id, title: request.title, href: request.received!.contentPath });
    }
    for (const item of evidence) {
      if (item.stageId !== stage.id || seen.has(item.id)) continue;
      seen.add(item.id);
      documents.push({ key: item.id, title: item.title, href: item.openPath });
    }

    stages.push({ id: stage.id, name: stage.name, state: stage.state, done, waiting, documents });
  }

  const waits = [...agreements.waiting, ...stages.flatMap((stage) => stage.waiting)];
  return {
    agreements,
    stages,
    upcoming,
    waitingOnClient: waits.filter((wait) => wait.on === "client").length,
    waitingOnUs: waits.filter((wait) => wait.on === "us").length,
  };
}

function WaitLine({ wait, ownerName }: { wait: OverviewWait; ownerName: string | null }) {
  const who = wait.on === "client" ? "The client" : ownerName ? `Us (${ownerName})` : "Us";
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <Hourglass className="mt-0.5 h-3 w-3 shrink-0 text-status-warning" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">{who}:</span>{" "}
        <span className="text-muted-foreground">{wait.text}</span>
      </span>
    </li>
  );
}

function DoneLine({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-status-success" aria-hidden="true" />
      <span>{text}</span>
    </li>
  );
}

/** Stage by stage: done, waiting and on whom, with the documents collected. */
export function ClientJourneyOverview({ caseId, ownerName = null }: { caseId: string; ownerName?: string | null }) {
  const journey = useQuery({
    queryKey: queryKeys.pipelines.caseJourney(caseId),
    queryFn: () => pipelinesApi.getCaseJourney(caseId),
  });
  const files = useQuery({
    queryKey: queryKeys.pipelines.caseFiles(caseId),
    queryFn: () => pipelinesApi.getCaseFiles(caseId),
  });
  // "Journey by stage" below shows the loading and error states; stay quiet here.
  if (!journey.data) return null;

  const overview = buildJourneyOverview(journey.data, files.data?.evidence ?? []);
  const { agreements } = overview;
  const summary =
    overview.waitingOnClient + overview.waitingOnUs === 0
      ? "Nothing is waiting."
      : [
        overview.waitingOnClient > 0 ? `${plural(overview.waitingOnClient, "thing")} waiting on the client` : null,
        overview.waitingOnUs > 0 ? `${plural(overview.waitingOnUs, "thing")} waiting on us` : null,
      ].filter(Boolean).join(", ") + ".";

  return (
    <div className="space-y-3" data-testid="client-journey-overview">
      <p className="text-sm font-medium text-foreground" data-testid="client-journey-overview-summary">{summary}</p>
      <ol className="divide-y divide-border rounded-md border border-border">
        <li className="px-3 py-2" aria-label="Agreements">
          <p className="text-sm font-medium text-foreground">Agreements</p>
          <ul className="mt-1 space-y-0.5">
            {agreements.done.map((text) => <DoneLine key={text} text={text} />)}
            {agreements.waiting.map((wait) => <WaitLine key={wait.text} wait={wait} ownerName={ownerName} />)}
          </ul>
        </li>
        {overview.stages.map((stage) => (
          <li key={stage.id} className="px-3 py-2" aria-label={stage.name} data-stage-state={stage.state}>
            <div className="flex flex-wrap items-center gap-2">
              {stage.state === "done" ? (
                <CircleCheck className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
              ) : (
                <CircleDot className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              )}
              <p className="text-sm font-medium text-foreground">{stage.name}</p>
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 text-xs",
                  stage.state === "done" ? "bg-muted text-muted-foreground" : "bg-accent text-foreground",
                )}
              >
                {stage.state === "done" ? "Done" : "Now"}
              </span>
            </div>
            {stage.done.length + stage.waiting.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {stage.done.map((text) => <DoneLine key={text} text={text} />)}
                {stage.waiting.map((wait) => <WaitLine key={wait.text} wait={wait} ownerName={ownerName} />)}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Nothing asked or expected at this stage yet.</p>
            )}
            {stage.documents.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Documents: </span>
                {stage.documents.map((document, index) => (
                  <span key={document.key}>
                    {index > 0 ? ", " : null}
                    {document.href ? (
                      <a href={document.href} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
                        {document.title}
                      </a>
                    ) : document.title}
                  </span>
                ))}
              </p>
            ) : null}
          </li>
        ))}
        {overview.upcoming.length > 0 ? (
          <li className="px-3 py-2 text-xs text-muted-foreground" aria-label="Still to come">
            <span className="font-medium text-foreground">Still to come: </span>
            {overview.upcoming.join(", ")}
          </li>
        ) : null}
      </ol>
    </div>
  );
}
