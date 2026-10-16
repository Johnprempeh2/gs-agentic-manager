// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGoal } from "@/lib/goal-journey.fixtures";
import { Goals } from "./Goals";

// GRE-1382: with the Strategy module off, the KPI cascade and the one-page
// plan button are hidden; plain goals still show.

const api = vi.hoisted(() => ({ settings: vi.fn(), goals: vi.fn() }));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: api.settings } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: api.goals, createStrategicPlan: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: vi.fn().mockResolvedValue({ users: [] }) } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
  useOptionalCompany: () => null,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
  useOptionalCompany: () => null,
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewGoal: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", toggleTheme: () => {} }) }));

async function flushReact() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

const goals = [
  makeGoal({ id: "c", kind: "csf", title: "Trusted brand" }),
  makeGoal({ id: "k", kind: "kpi", parentId: "c", title: "Net promoter score" }),
  makeGoal({ id: "plain", title: "Ship the website" }),
];

describe("Goals page and the Strategy module (GRE-1382)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.goals.mockResolvedValue(goals);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });
  async function render() {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Goals />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await flushReact();
  }

  it("hides the KPI cascade and the plan button while Strategy is off, and keeps plain goals", async () => {
    api.settings.mockResolvedValue({ enableStrategy: false });
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Ship the website");
    expect(text).not.toContain("Trusted brand");
    expect(text).not.toContain("Net promoter score");
    expect(text).not.toContain("One-page strategic plan");
  });

  it("shows the KPI cascade while Strategy is on", async () => {
    api.settings.mockResolvedValue({ enableStrategy: true });
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Ship the website");
    expect(text).toContain("Trusted brand");
    expect(text).toContain("Net promoter score");
  });

  it("offers the one-page plan only while Strategy is on", async () => {
    api.goals.mockResolvedValue([makeGoal({ id: "plain", title: "Ship the website" })]);
    api.settings.mockResolvedValue({ enableStrategy: true });
    await render();
    expect(container.textContent).toContain("One-page strategic plan");
  });

  it("filters to the goals that need attention, and back", async () => {
    api.goals.mockResolvedValue([
      makeGoal({ id: "fine", title: "Ship the website", targetDate: "2099-12-31" }),
      makeGoal({ id: "late", title: "Hire a designer", targetDate: "2020-01-01" }),
    ]);
    api.settings.mockResolvedValue({ enableStrategy: false });
    await render();
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Needs attention (1)");
    expect(button).toBeTruthy();
    flushSync(() => button!.click());
    expect(container.textContent).toContain("Hire a designer");
    expect(container.textContent).not.toContain("Ship the website");
    const back = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show every goal");
    flushSync(() => back!.click());
    expect(container.textContent).toContain("Ship the website");
  });
});
