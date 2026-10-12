// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/context/ToastContext";
import { PipelineSettings } from "./PipelineSettings";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockAccessApi = vi.hoisted(() => ({
  matrix: vi.fn(),
  setLevel: vi.fn(),
}));

const { PIPELINE, emptyApi } = vi.hoisted(() => {
  const PIPELINE = {
    id: "p-sales",
    companyId: "company-1",
    key: "sales",
    name: "Sales",
    archivedAt: null,
    stages: [
      {
        id: "s-new",
        pipelineId: "p-sales",
        key: "new",
        name: "New",
        kind: "open",
        position: 0,
        config: { automation: { assigneeAgentId: "a-harbor" } },
      },
    ],
    transitions: [],
  };

  // Every other API call resolves empty; the page only needs the pipeline.
  function emptyApi(overrides: Record<string, unknown> = {}) {
    return new Proxy(overrides, {
      get: (target, prop: string) =>
        target[prop] ?? vi.fn().mockResolvedValue([]),
    });
  }
  return { PIPELINE, emptyApi };
});

vi.mock("@/api/pipelineAccess", () => ({ pipelineAccessApi: mockAccessApi }));
vi.mock("../api/pipelines", () => ({
  pipelinesApi: emptyApi({
    get: vi.fn().mockResolvedValue(PIPELINE),
    getDocument: vi.fn().mockResolvedValue(null),
    getHealth: vi.fn().mockResolvedValue(null),
    getIntakeForm: vi.fn().mockResolvedValue(null),
  }),
}));
vi.mock("../api/agents", () => ({
  agentsApi: emptyApi({
    list: vi.fn().mockResolvedValue([
      { id: "a-harbor", companyId: "company-1", name: "Harbor", role: "general", status: "idle" },
    ]),
  }),
}));
vi.mock("../api/access", () => ({ accessApi: emptyApi() }));
vi.mock("../api/auth", () => ({
  authApi: emptyApi({ getSession: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: emptyApi(),
}));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: emptyApi({
    getExperimental: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock("../api/projects", () => ({ projectsApi: emptyApi() }));
vi.mock("../api/secrets", () => ({ secretsApi: emptyApi() }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useParams: () => ({ pipelineId: "p-sales" }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../hooks/useStandardMarkdownMentionOptions", () => ({
  useStandardMarkdownMentionOptions: () => [],
}));
vi.mock("@/hooks/useWorkspaceIsolationControls", () => ({
  useWorkspaceIsolationControls: () => ({ visible: false }),
}));
vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));
vi.mock("../components/PipelineAgentAccessSection", () => ({
  PipelineAgentAccessSection: () => null,
}));
vi.mock("../components/StageSecretsPanel", () => ({
  StageSecretsPanel: () => null,
}));
vi.mock("../components/PipelineStageHistoryPanel", () => ({
  PipelineStageHistoryPanel: () => null,
}));
// The rich editor does not run in jsdom; the stub keeps its readOnly contract.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    readOnly,
  }: {
    value?: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Stage instructions"
      readOnly={readOnly}
      value={value ?? ""}
      onChange={() => undefined}
    />
  ),
}));

function rights(administer: boolean) {
  return {
    canManage: false,
    canCreatePipelines: administer,
    administerPipelineIds: administer ? ["p-sales"] : [],
    pipelines: [{ id: "p-sales", name: "Sales", archivedAt: null }],
    agents: [],
  };
}

describe("pipeline settings controls follow the viewer's rights (GRE-1073)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAccessApi.matrix.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <PipelineSettings />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  const editor = () =>
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Stage instructions"]',
    );
  const actionsMenu = () =>
    container.querySelector('button[title="Pipeline actions"]');

  it("an administrator can edit the stage instructions", async () => {
    mockAccessApi.matrix.mockResolvedValue(rights(true));
    await render();
    expect(editor()).not.toBeNull();
    expect(editor()!.readOnly).toBe(false);
    expect(actionsMenu()).not.toBeNull();
  });

  it("a viewer gets a read-only stage instructions editor and no pipeline actions", async () => {
    mockAccessApi.matrix.mockResolvedValue(rights(false));
    await render();
    expect(editor()!.readOnly).toBe(true);
    expect(actionsMenu()).toBeNull();
    expect(container.textContent).toContain("You can view this pipeline.");
  });

  it("hides edit controls and says so when the rights cannot be read", async () => {
    mockAccessApi.matrix.mockRejectedValue(new Error("network down"));
    await render();
    expect(editor()!.readOnly).toBe(true);
    expect(actionsMenu()).toBeNull();
    expect(container.textContent).toContain(
      "Could not check your rights on this pipeline",
    );
  });
});
