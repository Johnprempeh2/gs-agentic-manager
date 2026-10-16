// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientJourneyResponse, ClientJourneyStage } from "@greatstone/shared";
import { MemoryRouter } from "react-router-dom";
import {
  ballWith,
  buildJourneyOverview,
  ClientJourneyOverview,
  daysSince,
  reminderEmail,
  statusEmail,
} from "./ClientJourneyOverview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getCaseJourney: vi.fn(), getCaseFiles: vi.fn(), listCaseContacts: vi.fn() }));
const mailboxes = vi.hoisted(() => ({ list: vi.fn(), saveDraft: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../api/pipelines", () => ({ pipelinesApi: api }));
vi.mock("../api/mailboxes", () => ({ mailboxesApi: mailboxes }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

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

describe("stuck days, the ball and the email drafts", () => {
  const overview = buildJourneyOverview(journey, evidence);

  it("counts whole days in the stage and says who has the next move", () => {
    expect(daysSince("2026-10-01T09:00:00Z", new Date("2026-10-16T08:00:00Z"))).toBe(14);
    expect(daysSince(null)).toBeNull();
    expect(daysSince("not a date")).toBeNull();
    expect(ballWith(overview)).toBe("client");
    const ours = buildJourneyOverview(
      { ...journey, engagement: { ...journey.engagement!, status: "accepted" }, stages: [journey.stages[1]!].map((entry) => ({ ...entry, requests: [] })) },
      [],
    );
    expect(ballWith(ours)).toBe("us");
  });

  it("drafts a reminder listing what the client owes, and a status update", () => {
    const context = { clientName: "Omni Bank", contactName: "Kofi Mensah", to: ["kofi@omni.example"] };
    const reminder = reminderEmail(overview, context);
    expect(reminder.subject).toBe("Omni Bank: a quick reminder");
    expect(reminder.to).toEqual(["kofi@omni.example"]);
    expect(reminder.text).toContain("Hello Kofi,");
    expect(reminder.text).toContain("- Accept the engagement pack\n- Send Org chart");
    expect(reminder.text).not.toContain("Deliver");

    const status = statusEmail(overview, { ...context, nextAction: "Playback workshop on 20 Oct." });
    expect(status.subject).toBe("Omni Bank: where things stand");
    expect(status.text).toContain("Current stage: Deep Dive.");
    expect(status.text).toContain("Completed: Executive Discovery.");
    expect(status.text).toContain("Documents received at this stage: IT strategy, Site photos.zip.");
    expect(status.text).toContain("Next step: Playback workshop on 20 Oct.\n");
    expect(status.text).toContain("After that: GDXP.");
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
    api.listCaseContacts.mockResolvedValue([{ id: "c1", name: "Kofi Mensah", email: "kofi@omni.example" }]);
    mailboxes.list.mockResolvedValue([
      { id: "mb-off", label: "Shared", address: "team@greatstone.example", allowDrafts: false },
      { id: "mb-1", label: "John", address: "john@greatstone.example", allowDrafts: true },
    ]);
    mailboxes.saveDraft.mockResolvedValue({ mailboxId: "mb-1", folder: "Drafts", subject: "s", to: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function settle() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("says how long the stage has waited and saves a reminder as a draft, never sending", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entered = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ClientJourneyOverview caseId="case-1" companyId="company-1" clientName="Omni Bank" stageEnteredAt={entered} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.querySelector("[data-testid='client-journey-overview-days']")?.textContent).toBe("Stuck for 10 days");
    expect(container.querySelector("[data-testid='client-journey-overview-ball']")?.textContent).toContain(
      "The ball is with the client.",
    );

    const remind = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Draft a reminder")!;
    await act(async () => remind.click());
    await settle();
    expect(document.body.textContent).toContain("Saving in John.");
    expect(document.querySelector<HTMLInputElement>("#email-draft-to")?.value).toBe("kofi@omni.example");
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save as draft")!;
    await act(async () => save.click());
    await settle();
    expect(mailboxes.saveDraft).toHaveBeenCalledWith("company-1", "mb-1", expect.objectContaining({
      to: ["kofi@omni.example"],
      cc: [],
      subject: "Omni Bank: a quick reminder",
    }));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft saved" }));
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
