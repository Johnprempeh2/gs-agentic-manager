// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientJourneyResponse, ClientJourneyStage } from "@greatstone/shared";
import { buildJourneyOverview, ClientJourneyOverview } from "./ClientJourneyOverview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getCaseJourney: vi.fn(), getCaseFiles: vi.fn() }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: api }));

function stage(overrides: Partial<ClientJourneyStage>): ClientJourneyStage {
  return {
    id: "s1",
    key: "discovery",
    name: "Executive Discovery",
    kind: "open",
    position: 0,
    state: "done",
    templates: [],
    deliverables: [],
    expected: [],
    requests: [],
    suggestedRequests: [],
    ...overrides,
  };
}

const journey: ClientJourneyResponse = {
  caseId: "case-1",
  ndaAcceptedAt: "2026-10-10T00:00:00Z",
  nda: { status: "accepted", acceptedAt: "2026-10-10T00:00:00Z", suspendedReason: null, changedBy: null, changedAt: null },
  engagement: {
    status: "sent", sentAt: "2026-10-12T00:00:00Z", acceptedAt: null, changedBy: null, changedAt: null, pack: null, acceptance: null,
  },
  stages: [
    stage({}),
    stage({
      id: "s2",
      name: "Deep Dive",
      state: "current",
      expected: [{ key: "report", title: "Deep Dive report", kind: null, deliverableId: null }],
      requests: [
        {
          id: "r1", stageId: "s2", title: "IT strategy", note: null, createdAt: "2026-10-13T00:00:00Z",
          received: { evidenceId: "ev-1", title: "Strategy.pdf", contentPath: "/api/cases/case-1/evidence/ev-1/content", receivedAt: "2026-10-14T00:00:00Z" },
        },
        { id: "r2", stageId: "s2", title: "Org chart", note: null, createdAt: "2026-10-13T00:00:00Z", received: null },
      ],
    }),
    stage({ id: "s3", name: "GDXP", state: "next" }),
    stage({ id: "s4", name: "Paused", state: "side" }),
  ],
  unfiled: [],
};

const evidence = [
  { id: "ev-1", stageId: "s2", title: "Strategy.pdf", openPath: "/api/cases/case-1/evidence/ev-1/content" },
  { id: "ev-2", stageId: "s2", title: "Site photos.zip", openPath: "/api/cases/case-1/evidence/ev-2/content" },
  { id: "ev-3", stageId: null, title: "Loose note", openPath: "/x" },
];

describe("buildJourneyOverview", () => {
  it("says what is done, what waits on the client and on us, and lists each stage's documents once", () => {
    const overview = buildJourneyOverview(journey, evidence);
    expect(overview.agreements).toEqual({
      done: ["NDA accepted"],
      waiting: [{ on: "client", text: "Accept the engagement pack" }],
    });
    expect(overview.stages.map((entry) => entry.name)).toEqual(["Executive Discovery", "Deep Dive"]);
    const deepDive = overview.stages[1]!;
    expect(deepDive.done).toEqual(["1 of 2 documents received"]);
    expect(deepDive.waiting).toEqual([
      { on: "client", text: "Send Org chart" },
      { on: "us", text: "Deliver Deep Dive report" },
    ]);
    expect(deepDive.documents.map((document) => document.title)).toEqual(["IT strategy", "Site photos.zip"]);
    expect(overview.upcoming).toEqual(["GDXP"]);
    expect(overview.waitingOnClient).toBe(2);
    expect(overview.waitingOnUs).toBe(1);
  });

  it("asks the client for the NDA first, and us for the pack once it clears", () => {
    const required = buildJourneyOverview({ ...journey, nda: { ...journey.nda, status: "required" }, engagement: undefined, stages: [] }, []);
    expect(required.agreements.waiting).toEqual([{ on: "client", text: "Sign the NDA" }]);
    const cleared = buildJourneyOverview({ ...journey, engagement: undefined, stages: [] }, []);
    expect(cleared.agreements.waiting).toEqual([{ on: "us", text: "Send the engagement pack" }]);
  });
});

describe("ClientJourneyOverview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.getCaseJourney.mockResolvedValue(journey);
    api.getCaseFiles.mockResolvedValue({ evidence, deliverables: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names who each wait is on and links the collected documents", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ClientJourneyOverview caseId="case-1" ownerName="Ama Owusu" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-testid='client-journey-overview-summary']")?.textContent).toBe(
      "2 things waiting on the client, 1 thing waiting on us.",
    );
    const deepDive = container.querySelector("[aria-label='Deep Dive']")!;
    expect(deepDive.textContent).toContain("Now");
    expect(deepDive.textContent).toContain("The client: Send Org chart");
    expect(deepDive.textContent).toContain("Us (Ama Owusu): Deliver Deep Dive report");
    expect(deepDive.querySelector("a[href='/api/cases/case-1/evidence/ev-1/content']")?.textContent).toBe("IT strategy");
    expect(container.querySelector("[aria-label='Still to come']")?.textContent).toBe("Still to come: GDXP");
    expect(container.textContent).not.toContain("Paused");
  });
});
