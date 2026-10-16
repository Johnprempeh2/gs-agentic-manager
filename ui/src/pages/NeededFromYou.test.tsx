// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeededFromYou } from "./NeededFromYou";

const state = vi.hoisted(() => ({ cards: [] as unknown[], assignedTasks: [] as unknown[], pipelines: false, dismissals: [] as unknown[] }));
const inbox = vi.hoisted(() => ({ snooze: vi.fn(), restore: vi.fn(), pushToast: vi.fn() }));

vi.mock("@/hooks/useDecisionsFeed", () => ({
  useDecisionsFeed: () => ({ data: { cards: state.cards }, isLoading: false, error: null, refetch: vi.fn() }),
  useNeedsMe: () => ({ data: { assignedTasks: state.assignedTasks, overdueWaits: [] }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enablePipelines: state.pipelines }) } }));
vi.mock("@/api/pipelines", () => ({ pipelinesApi: { listAttention: async () => ({ reviews: [], suggestions: [], headsUp: [], counts: {} }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/components/decisions-feed/DecisionFeedCard", () => ({
  DecisionFeedCard: ({ card, currentUserId }: { card: { title: string }; currentUserId: string | null }) => (
    <div data-testid="decision-card">{card.title} for {currentUserId}</div>
  ),
}));
vi.mock("@/components/AgentWorkDigest", () => ({ DashboardDigestCard: () => <div data-testid="digest">digest</div> }));
vi.mock("@/hooks/useInboxBadge", () => ({
  useInboxDismissals: () => ({ dismissals: state.dismissals, snooze: inbox.snooze, restore: inbox.restore }),
}));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: inbox.pushToast }) }));
vi.mock("@/components/BrandPageTitle", () => ({ BrandCaughtUpMark: () => null }));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.cards = [];
  state.assignedTasks = [];
  state.dismissals = [];
  inbox.snooze.mockReset();
  inbox.restore.mockReset();
  inbox.pushToast.mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><NeededFromYou /></MemoryRouter>
    </QueryClientProvider>,
  ));
}

const questionCard = (id: string) => ({
  id, kind: "question", kinds: ["question"], title: `Pick a supplier ${id}`, reason: "Two quotes came in.",
  task: { kind: "issue", id: `issue-${id}`, companyId: "company-1", title: "", identifier: `GRE-${id}`, status: "blocked", href: null },
  waiting: { id: "a", name: "Everest" }, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  actions: [], items: [], clarity: null, severity: "medium", nextStep: "", activityAt: "",
});

describe("NeededFromYou", () => {
  it("says all clear when nothing waits", async () => {
    await render();
    expect(container.textContent).toContain("Nothing needs you right now");
    expect(container.textContent).toContain("You are all caught up");
    // Even when nothing waits, the page says what the agents did meanwhile.
    expect(container.querySelector('[data-testid="needed-meanwhile"] [data-testid="digest"]')).not.toBeNull();
  });

  it("groups what waits, names who is waiting, and caps each group", async () => {
    state.cards = ["1", "2", "3", "4"].map(questionCard);
    state.assignedTasks = [{ id: "t1", identifier: "GRE-9", title: "Sign the lease", status: "todo", priority: "high", updatedAt: new Date().toISOString() }];
    await render();
    expect(container.querySelector('[data-testid="needed-summary"]')?.textContent).toBe("5 things need you. The oldest has waited 3 hours.");
    const answer = container.querySelector('[data-testid="needed-group-answer"]')!;
    expect(answer.textContent).toContain("Answer a question");
    expect(answer.querySelectorAll("li")).toHaveLength(3);
    expect(answer.textContent).toContain("Everest has waited 3 hours");
    expect(answer.textContent).toContain("and 1 more");
    expect(answer.querySelector("li a")?.getAttribute("href")).toBe("/issues/GRE-1");
    expect(container.querySelector('[data-testid="needed-group-tasks"]')?.textContent).toContain("Sign the lease");
  });

  it("opens a decision in place so it can be acted on without leaving the page", async () => {
    state.cards = [questionCard("1")];
    state.assignedTasks = [{ id: "t1", identifier: "GRE-9", title: "Sign the lease", status: "todo", priority: "high", updatedAt: new Date().toISOString() }];
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const actHere = [...container.querySelectorAll("button")].filter((el) => el.textContent === "Act here");
    // Only decision cards can be acted on here; plain tasks open their page.
    expect(actHere).toHaveLength(1);
    expect(actHere[0].getAttribute("aria-label")).toBe("Act on Pick a supplier 1 here");
    await act(async () => actHere[0].click());
    expect(container.querySelector('[data-testid="decision-card"]')?.textContent).toBe("Pick a supplier 1 for user-1");
    const close = [...container.querySelectorAll("button")].find((el) => el.textContent === "Close")!;
    await act(async () => close.click());
    expect(container.querySelector('[data-testid="decision-card"]')).toBeNull();
  });

  it("leaves out rows put away for later until the snooze ends", async () => {
    state.cards = [questionCard("1"), questionCard("2")];
    state.dismissals = [
      { kind: "snooze", itemKey: "attention:needed:1", snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: "snooze", itemKey: "attention:needed:2", snoozedUntil: new Date(Date.now() - 3_600_000).toISOString() },
    ];
    await render();
    const answer = container.querySelector('[data-testid="needed-group-answer"]')!;
    expect(answer.textContent).not.toContain("Pick a supplier 1");
    expect(answer.textContent).toContain("Pick a supplier 2");
    expect(container.querySelector('[data-testid="needed-summary"]')?.textContent).toContain("1 thing needs you");
  });
});
