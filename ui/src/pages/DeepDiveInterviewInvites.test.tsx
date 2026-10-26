// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveInterviewProgress, DeepDiveInterviewRound, DeepDiveInterviewSet } from "@greatstone/shared";
import { InterviewInvites } from "./DeepDiveInterviewInvites";

// Generic fixtures only: "Client company". Never a real client.
const COMPANY_ID = "company-1";

const mockApi = vi.hoisted(() => ({ progress: vi.fn(), open: vi.fn(), invite: vi.fn(), send: vi.fn() }));
const mockOrg = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/deepDiveInterviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveInterviews")>()),
  deepDiveInterviewsApi: mockApi,
}));
vi.mock("@/api/deepDiveBoards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveBoards")>()),
  deepDiveOrgApi: mockOrg,
}));

function set(id: string, unitId: string, name: string, status: "draft" | "approved"): DeepDiveInterviewSet {
  return {
    id,
    roundId: "round-1",
    target: { kind: "unit", id: unitId, name, detail: "Team" },
    status,
    questions: [{ prompt: "How does month-end work today?", purpose: "investigate", streamKey: "operations", gifKey: "current-state" }],
    known: [],
    leftOut: 0,
    approvedByUserId: status === "approved" ? "user-1" : null,
    approvedAt: status === "approved" ? "2026-10-25T11:00:00.000Z" : null,
    draftedByAgentId: null,
    draftedByUserId: "user-1",
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
  };
}

function round(status: DeepDiveInterviewRound["status"], sets: DeepDiveInterviewSet[]): DeepDiveInterviewRound {
  return {
    id: "round-1",
    companyId: COMPANY_ID,
    websiteOrganisationId: "org_client",
    mode: "per_team",
    targetMinutes: 20,
    contextPack: {},
    status,
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
    sets,
  };
}

const counts = (partial: Partial<DeepDiveInterviewProgress["counts"]>) => ({ invited: 0, started: 0, completed: 0, abandoned: 0, declined: 0, ...partial });

function progress(): DeepDiveInterviewProgress {
  const person = (over: Partial<DeepDiveInterviewProgress["people"][number]>) => ({
    websiteEmployeeId: "emp_1", websiteUserId: null, name: "", email: "", roleTitle: "", unitId: "unit-finance", teamName: "Finance", setId: "set-1",
    status: "invited" as const, startedAt: null, endedAt: null, completionScore: null, invitedAt: "2026-10-25T12:00:00.000Z",
    sentCount: 1, lastSentAt: "2026-10-25T12:00:00.000Z", remindedCount: 0, lastRemindedAt: null, ...over,
  });
  return {
    roundId: "round-1",
    status: "open",
    websiteOrganisationId: "org_client",
    allowedEmailDomains: ["client.example"],
    seatTotal: 20,
    readAt: "2026-10-25T12:05:00.000Z",
    total: 3,
    counts: counts({ completed: 1, started: 1, invited: 1 }),
    teams: [
      { unitId: "unit-finance", name: "Finance", total: 2, counts: counts({ completed: 1, started: 1 }) },
      { unitId: "unit-depot", name: "Depot", total: 1, counts: counts({ invited: 1 }) },
    ],
    people: [
      person({ websiteEmployeeId: "emp_a", websiteUserId: "usr_a", name: "Person A", email: "a@client.example", status: "completed" }),
      person({ websiteEmployeeId: "emp_b", name: "Person B", email: "b@client.example", status: "started" }),
      person({ websiteEmployeeId: "emp_c", name: "Person C", email: "c@client.example", unitId: "unit-depot", teamName: "Depot" }),
    ],
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function waitFor(assertion: () => void, attempts = 40) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

describe("Parallel Interview invites and progress", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of [...Object.values(mockApi), ...Object.values(mockOrg)]) fn.mockReset();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  function render(value: DeepDiveInterviewRound) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InterviewInvites round={value} companyId={COMPANY_ID} />
        </QueryClientProvider>,
      );
    });
  }

  it("will not open the round until every question set is approved", async () => {
    render(round("setup", [set("set-1", "unit-finance", "Finance", "approved"), set("set-2", "unit-depot", "Depot", "draft")]));
    await flush();
    expect(container.textContent).toContain("1 of 2 question sets approved");
    expect(button(container, "Open the round")!.disabled).toBe(true);
    expect(mockApi.progress).not.toHaveBeenCalled();
  });

  it("opens the round with the email domains and seats", async () => {
    mockApi.open.mockResolvedValue({ ...progress(), total: 0, teams: [], people: [] });
    render(round("setup", [set("set-1", "unit-finance", "Finance", "approved")]));
    await flush();
    const domains = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Email domains"))!.querySelector("input")!;
    button(container, "Open the round")!.click();
    await waitFor(() => expect(container.textContent).toContain("Give at least one email domain"));
    expect(mockApi.open).not.toHaveBeenCalled();
    setValue(domains, "Client.example, other.example");
    await flush();
    button(container, "Open the round")!.click();
    await waitFor(() => expect(mockApi.open).toHaveBeenCalledWith("round-1", { allowedEmailDomains: ["client.example", "other.example"], seatTotal: 10 }));
  });

  it("invites a board person, then shows progress per team and per person with resend and remind", async () => {
    mockApi.progress.mockResolvedValue({ ...progress(), total: 0, counts: counts({}), teams: [], people: [] });
    mockOrg.get.mockResolvedValue({
      companyId: COMPANY_ID,
      units: [],
      tasks: [],
      people: [
        { id: "person-a", name: "Person A", role: "Finance lead", side: "client", unitId: "unit-finance", reportsToId: null, visibility: "internal" },
        { id: "person-g", name: "Consultant", role: "", side: "greatstone", unitId: null, reportsToId: null, visibility: "internal" },
      ],
    });
    mockApi.invite.mockResolvedValue({ invited: 1, created: 1, emailed: 1, progress: progress() });
    mockApi.send.mockResolvedValue({ emailed: 1, skipped: 0, progress: progress() });
    render(round("open", [set("set-1", "unit-finance", "Finance", "approved"), set("set-2", "unit-depot", "Depot", "approved")]));
    await waitFor(() => expect(container.textContent).toContain("Nobody is on the round yet"));

    // Only the client's people are offered from the board.
    const options = [...container.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Person A, Finance lead");
    expect(options.join(" ")).not.toContain("Consultant");
    button(container, "Add")!.click();
    await waitFor(() => expect(button(container, "Send 1 invite")).toBeTruthy());
    button(container, "Send 1 invite")!.click();
    await waitFor(() => expect(container.textContent).toContain("give an email, or the id of their existing website account"));
    expect(mockApi.invite).not.toHaveBeenCalled();

    setValue(container.querySelector<HTMLInputElement>('input[aria-label="Email or website user id for person 1"]')!, "a@client.example");
    await flush();
    button(container, "Send 1 invite")!.click();
    await waitFor(() =>
      expect(mockApi.invite).toHaveBeenCalledWith("round-1", {
        people: [{ boardPersonId: "person-a", email: "a@client.example", unitId: "unit-finance" }],
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("1 invited, 1 emailed the join link."));

    // Per team, then per person, with the status read from the website.
    const teams = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(teams).toEqual(["Finance", "Depot"]);
    expect(container.textContent).toContain("1 of 3 completed");
    expect(container.textContent).toContain("1 of 2 completed");
    expect(container.textContent).toContain("1 completed, 1 started, 1 invited");
    expect(button(container, "Remind")).toBeTruthy();
    expect(button(container, "Resend")).toBeTruthy();
    button(container, "Remind")!.click();
    await waitFor(() => expect(mockApi.send).toHaveBeenCalledWith("round-1", { kind: "remind", websiteEmployeeIds: ["emp_b"] }));
  });

  it("says when the website cannot be read and offers to try again", async () => {
    mockApi.progress.mockRejectedValue(new Error("The website data bridge is not set up for this site."));
    mockOrg.get.mockResolvedValue({ companyId: COMPANY_ID, units: [], tasks: [], people: [] });
    render(round("open", [set("set-1", "unit-finance", "Finance", "approved")]));
    await waitFor(() => expect(container.textContent).toContain("The website data bridge is not set up for this site."));
    mockApi.progress.mockResolvedValue(progress());
    button(container, "Try again")!.click();
    await waitFor(() => expect(container.textContent).toContain("Person C"));
  });
});
