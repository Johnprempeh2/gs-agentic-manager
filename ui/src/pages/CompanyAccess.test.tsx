// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./CompanyAccess";

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberMock = vi.hoisted(() => vi.fn());
const archiveMemberMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listIssuesMock = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const listInvitesMock = vi.hoisted(() => vi.fn());
const listCloudStacksMock = vi.hoisted(() => vi.fn());
const mockSearchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));
const handOverMemberMock = vi.hoisted(() => vi.fn());
const restoreMemberMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/cloud", () => ({
  cloudApi: { listStacks: listCloudStacksMock },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    handOverMember: (companyId: string, memberId: string, input: unknown) => handOverMemberMock(companyId, memberId, input),
    restoreMember: (companyId: string, memberId: string) => restoreMemberMock(companyId, memberId),
    listJoinRequests: (companyId: string, status: string) => listJoinRequestsMock(companyId, status),
    updateMember: (companyId: string, memberId: string, input: unknown) =>
      updateMemberMock(companyId, memberId, input),
    updateMemberPermissions: vi.fn(),
    updateMemberAccess: vi.fn(),
    archiveMember: (companyId: string, memberId: string, input: unknown) =>
      archiveMemberMock(companyId, memberId, input),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    listInvites: (companyId: string, options: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: vi.fn(),
    revokeInvite: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters: unknown) => listIssuesMock(companyId, filters),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    mockNavigate(to, replace);
    return <div data-testid="navigate">{to}</div>;
  },
  useSearchParams: () => [
    mockSearchParamsState.current,
    (
      updater:
        | URLSearchParams
        | ((prev: URLSearchParams) => URLSearchParams),
    ) => {
      mockSearchParamsState.current =
        typeof updater === "function"
          ? updater(mockSearchParamsState.current)
          : new URLSearchParams(updater);
    },
  ],
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "GS Agentic Manager" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyAccess", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSearchParamsState.current = new URLSearchParams();
    listInvitesMock.mockResolvedValue({ invites: [], nextOffset: null });
    listMembersMock.mockResolvedValue({
      members: [
        {
          id: "member-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-1",
            email: "codexcoder@paperclip.local",
            name: "Codex Coder",
            image: "/api/assets/avatar-1/content",
          },
          grants: [],
        },
        {
          id: "member-2",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-2",
          status: "active",
          membershipRole: "operator",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-2",
            email: "board@paperclip.local",
            name: "Board User",
            image: null,
          },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    listJoinRequestsMock.mockResolvedValue([
      {
        id: "join-1",
        requestType: "human",
        createdAt: "2026-04-10T00:00:00.000Z",
        requesterUser: {
          id: "user-2",
          email: "board@paperclip.local",
          name: "Board User",
          image: null,
        },
        requestEmailSnapshot: "board@paperclip.local",
        requestingUserId: "user-2",
        invite: {
          allowedJoinTypes: "human",
          humanRole: "operator",
        },
      },
      {
        id: "join-2",
        requestType: "agent",
        createdAt: "2026-04-10T00:00:00.000Z",
        agentName: "Codex Worker",
        adapterType: "codex_local",
        capabilities: "Implements code changes",
        invite: {
          allowedJoinTypes: "agent",
          humanRole: null,
        },
      },
    ]);
    updateMemberMock.mockResolvedValue({});
    archiveMemberMock.mockResolvedValue({ reassignedIssueCount: 1 });
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Codex Worker",
        role: "engineer",
        status: "active",
      },
    ]);
    listIssuesMock.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Assigned to removed user",
        status: "todo",
      },
    ]);
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a compact member table without redundant explanatory copy", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Manage the people who can work in GS Agentic Manager");
    expect(container.textContent).not.toContain("Members can collaborate across the company by default");
    expect(container.textContent).not.toContain("Core keeps this page focused on membership");
    expect(container.textContent).not.toContain("Manage human company memberships and status here");
    expect(container.textContent).toContain("Pending human joins");
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Email");
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Grants");
    expect(container.textContent).not.toContain("explicit grants");
    expect(container.textContent).not.toContain("Assign scoped tasks");
    expect(container.textContent).not.toContain("Agents");
    expect(container.textContent).not.toContain("Pending agent joins");
    expect(container.textContent).not.toContain("Open join request queue");
    expect(container.textContent).not.toContain("Manage invites");
    expect(container.textContent).not.toContain("Active user accounts");
    expect(container.textContent).not.toContain("Suspended user accounts");
    expect(container.textContent).not.toContain("Pending user joins");

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Update organization role and membership status");
    expect(document.body.textContent).not.toContain("Implicit grants from role");
    expect(document.body.textContent).not.toContain("permissionKey");

    await act(async () => {
      root.unmount();
    });
  });

  const canHandOver = { canHandOver: true, handOverReason: null, canRestore: false, restoreReason: null };

  function member(overrides: Record<string, unknown>) {
    return {
      companyId: "company-1",
      principalType: "user",
      status: "active",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      grants: [],
      ...overrides,
    };
  }

  function handoverMembers(extra: Array<Record<string, unknown>> = []) {
    return {
      members: [
        member({
          id: "member-1", principalId: "user-1", membershipRole: "owner",
          user: { id: "user-1", email: "owner@example.com", name: "Owner One", image: null },
          handover: { canHandOver: false, handOverReason: "You cannot hand over yourself.", canRestore: false, restoreReason: null },
        }),
        member({
          id: "member-2", principalId: "user-2", membershipRole: "operator",
          user: { id: "user-2", email: "leaver@example.com", name: "Leaving Person", image: null },
          handover: canHandOver,
        }),
        ...extra,
      ],
      access: {
        currentUserRole: "owner",
        currentUserId: "user-1",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: false,
      },
    };
  }

  function plan(overrides: Record<string, unknown> = {}) {
    return {
      dryRun: true,
      companyId: "company-1",
      member: { membershipId: "member-2", userId: "user-2", name: "Leaving Person", email: null, role: "operator", status: "active", isInstanceAdmin: false },
      successor: { userId: "user-1", name: "Owner One" },
      items: [
        {
          ref: "issue:issue-7", group: "work", kind: "issue", title: "GRE-7 Ship the report", detail: "todo: assignee",
          link: "/issues/GRE-7", roles: ["assignee"],
          recommended: { type: "move_to_user", userId: "user-1" }, planned: { type: "move_to_user", userId: "user-1" },
          choices: ["user", "agent", "unassign", "close", "leave"], blocker: null, warning: null,
        },
        {
          ref: "grant:g-1", group: "connections", kind: "ai_connection", title: "Leaver Claude", detail: "Personal AI account",
          link: null, recommended: { type: "revoke" }, planned: { type: "revoke" }, choices: [], blocker: null, warning: null,
        },
        {
          ref: "membership", group: "access", kind: "membership", title: "Membership (operator)", detail: null,
          link: null, recommended: { type: "archive" }, planned: { type: "archive" }, choices: [], blocker: null, warning: null,
        },
      ],
      blockers: [],
      warnings: [],
      reconnect: [{ kind: "ai", name: "Leaver Claude", detail: "Connect your own Claude account in Apps." }],
      counts: { issues: 1, interactions: 0, routines: 0, agentsRepointed: 0, connectionsRevoked: 1, memoryGrantsRemoved: 0, permissionGrantsRemoved: 0, boardKeysRevoked: 0, sessionsEnded: 0 },
      handoverIssue: null,
      ...overrides,
    };
  }

  async function renderAccess() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  function findButton(label: string, scope: ParentNode = document.body) {
    return Array.from(scope.querySelectorAll("button")).find((button) => button.textContent === label);
  }

  async function click(element: Element | undefined | null) {
    expect(element).toBeTruthy();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
  }

  it("hands over and removes a person in three steps, with a per-item change", async () => {
    listMembersMock.mockResolvedValue(handoverMembers());
    handOverMemberMock.mockImplementation(async (_companyId: string, _memberId: string, input: { dryRun: boolean }) =>
      input.dryRun ? plan() : plan({ dryRun: false, handoverIssue: { id: "issue-99", identifier: "GRE-99", title: "Handover from Leaving Person" } }));
    const root = await renderAccess();

    const rowButtons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "Hand over and remove");
    expect(rowButtons).toHaveLength(2);
    expect(rowButtons[0]).toHaveProperty("disabled", true);
    expect(rowButtons[0]?.getAttribute("title")).toBe("You cannot hand over yourself.");
    await click(rowButtons[1]);

    // Step 1: the successor defaults to the viewer.
    const successor = document.body.querySelector('select[aria-label="Successor"]') as HTMLSelectElement;
    expect(successor.value).toBe("user-1");
    await click(findButton("Next"));

    // Step 2: the grouped plan, with a change for the task.
    expect(handOverMemberMock).toHaveBeenLastCalledWith("company-1", "member-2", {
      successorUserId: "user-1", overrides: [], dryRun: true, removeInstanceAdmin: false,
    });
    expect(document.body.textContent).toContain("Open work");
    expect(document.body.textContent).toContain("GRE-7 Ship the report");
    expect(document.body.textContent).toContain("Connections");
    const taskSelect = document.body.querySelector('select[aria-label="Where GRE-7 Ship the report goes"]') as HTMLSelectElement;
    await act(async () => {
      taskSelect.value = "close";
      taskSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    expect(handOverMemberMock).toHaveBeenLastCalledWith("company-1", "member-2", {
      successorUserId: "user-1", overrides: [{ itemRef: "issue:issue-7", action: "close" }], dryRun: true, removeInstanceAdmin: false,
    });
    await click(findButton("Next"));

    // Step 3: the summary, then the real run.
    expect(document.body.textContent).toContain("Owner One needs to reconnect");
    const confirm = findButton("Hand over and remove", document.body.querySelector('[role="dialog"]')!);
    await click(confirm);
    expect(handOverMemberMock).toHaveBeenLastCalledWith("company-1", "member-2", {
      successorUserId: "user-1", overrides: [{ itemRef: "issue:issue-7", action: "close" }], dryRun: false, removeInstanceAdmin: false,
    });
    const taskLink = Array.from(document.body.querySelectorAll("a")).find((link) => link.textContent?.includes("Handover from Leaving Person"));
    expect(taskLink?.getAttribute("href")).toBe("/issues/GRE-99");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows blockers in red and will not go past the review", async () => {
    listMembersMock.mockResolvedValue(handoverMembers());
    handOverMemberMock.mockResolvedValue(plan({ blockers: ["Nova: Nova would have no AI account"] }));
    const root = await renderAccess();
    await click(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "Hand over and remove")[1]);
    await click(findButton("Next"));

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Nova would have no AI account");
    expect(alert?.className).toContain("text-destructive");
    expect(findButton("Next")).toHaveProperty("disabled", true);
    expect(handOverMemberMock).not.toHaveBeenCalledWith("company-1", "member-2", expect.objectContaining({ dryRun: false }));

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the same flow for the legacy local-board account, with the primary owner as successor", async () => {
    listMembersMock.mockResolvedValue(handoverMembers([
      member({
        id: "member-legacy", principalId: "local-board", membershipRole: "owner", createdAt: "2026-01-01T00:00:00.000Z",
        user: { id: "local-board", email: "local@paperclip.local", name: "John Prempeh (legacy)", image: null },
        handover: canHandOver,
      }),
    ]));
    handOverMemberMock.mockResolvedValue(plan());
    const root = await renderAccess();
    expect(container.textContent).not.toContain("Retire legacy account");
    const buttons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "Hand over and remove");
    await click(buttons[2]);
    const successor = document.body.querySelector('select[aria-label="Successor"]') as HTMLSelectElement;
    expect(successor.value).toBe("user-1");
    expect(Array.from(successor.options).map((option) => option.value)).not.toContain("local-board");
    await act(async () => {
      root.unmount();
    });
  });

  it("restores a removed person from their row", async () => {
    listMembersMock.mockResolvedValue(handoverMembers([
      member({
        id: "member-gone", principalId: "user-gone", membershipRole: "admin", status: "suspended",
        user: { id: "user-gone", email: "gone@example.com", name: "Gone Admin", image: null },
        handover: { canHandOver: false, handOverReason: "This person is already removed.", canRestore: true, restoreReason: null },
      }),
    ]));
    restoreMemberMock.mockResolvedValue({});
    const root = await renderAccess();
    await click(findButton("Restore"));
    expect(restoreMemberMock).toHaveBeenCalledWith("company-1", "member-gone");
    await act(async () => {
      root.unmount();
    });
  });

  it("saves member role and status without touching grants", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Save member",
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateMemberMock).toHaveBeenCalledWith("company-1", "member-1", {
      membershipRole: "owner",
      status: "active",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("redirects legacy access deep links to the permissions extension route when installed", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          routePath: "permissions",
          pluginKey: "permissions-extension",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/company/settings/permissions", true);
    expect(container.textContent).toContain("/company/settings/permissions");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a read-only unavailable fallback for legacy access deep links", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Advanced Permissions");
    expect(container.textContent).toContain("Advanced permissions unavailable");
    expect(container.textContent).toContain("Open Members");
    expect(container.textContent).toContain("Open Invites");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CompanyAccess invites tab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSearchParamsState.current = new URLSearchParams();
    listInvitesMock.mockResolvedValue({ invites: [], nextOffset: null });
    listCloudStacksMock.mockResolvedValue({ stacks: [] });
    listMembersMock.mockResolvedValue({
      members: [],
      access: { currentUserRole: "owner", canApproveJoinRequests: false },
    });
    listAgentsMock.mockResolvedValue([]);
    listJoinRequestsMock.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage(queryClient?: QueryClient) {
    const root = createRoot(container);
    const client =
      queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("shows Members and Invites tabs with Members active by default", async () => {
    const root = await renderPage();

    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Members", "Invites"]);
    expect(container.textContent).toContain("Organization Members");
    expect(container.textContent).not.toContain("Invite a person");
    expect(container.textContent).not.toContain("Invite people");
    expect(listCloudStacksMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the Invites tab from a ?tab=invites deep link", async () => {
    mockSearchParamsState.current = new URLSearchParams("tab=invites");
    const root = await renderPage();

    expect(container.textContent).toContain("Invite a person");
    expect(container.textContent).toContain("Invite history");

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the Invites tab when the operator hides company.invites", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["health"], { hiddenSettings: ["company.invites"] } as never);
    mockSearchParamsState.current = new URLSearchParams("tab=invites");
    const root = await renderPage(client);

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("Invite a person");
    expect(container.textContent).toContain("Organization Members");
    expect(listInvitesMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  function cloudClient(cloudBaseUrl: string | null = "https://cloud.example.test") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["health"], {
      hiddenSettings: ["company.invites"],
      cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl, stackSlug: "old-slug" },
    });
    return client;
  }

  function cloudStack(role: string, isCurrent = true) {
    return { stackSlug: isCurrent ? "current-team" : "other-team", role, isCurrent,
      displayName: "Team", primaryHost: null, lifecycleState: "active", sleepState: "awake" };
  }

  it.each(["owner", "admin"])("offers Cloud invitations to the current stack's %s even with local invites hidden", async (role) => {
    listCloudStacksMock.mockResolvedValue({ stacks: [cloudStack("owner", false), cloudStack(role)] });
    const root = await renderPage(cloudClient());

    const invite = [...container.querySelectorAll("a")].find((link) => link.textContent === "Invite people");
    expect(invite?.getAttribute("href")).toBe("https://cloud.example.test/workspaces/current-team/settings?section=people");
    expect(invite?.getAttribute("target")).toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(listInvitesMock).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it.each(["member", "support", "unknown"])("does not expose Cloud invitations to a %s who owns another stack", async (role) => {
    listCloudStacksMock.mockResolvedValue({ stacks: [cloudStack("owner", false), cloudStack(role)] });
    const root = await renderPage(cloudClient());
    expect(container.textContent).not.toContain("Invite people");
    await act(async () => root.unmount());
  });

  it("waits for the Cloud role before showing the invitation action", async () => {
    let resolveStacks!: (value: { stacks: ReturnType<typeof cloudStack>[] }) => void;
    listCloudStacksMock.mockReturnValue(new Promise((resolve) => { resolveStacks = resolve; }));
    const root = await renderPage(cloudClient());
    expect(container.textContent).not.toContain("Invite people");
    await act(async () => resolveStacks({ stacks: [cloudStack("admin")] }));
    await flushReact();
    expect(container.textContent).toContain("Invite people");
    await act(async () => root.unmount());
  });

  it("hides a cached invitation action when the Cloud role refresh fails", async () => {
    const client = cloudClient();
    client.setQueryData(["cloud", "stacks"], { stacks: [cloudStack("owner")] });
    const root = await renderPage(client);
    expect(container.textContent).toContain("Invite people");
    listCloudStacksMock.mockRejectedValue(new Error("Portfolio unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["cloud", "stacks"] }); });
    await flushReact();
    expect(container.textContent).not.toContain("Invite people");
    await act(async () => root.unmount());
  });

  it("requires an identified current stack and a configured Cloud destination", async () => {
    listCloudStacksMock.mockResolvedValue({ stacks: [cloudStack("owner", false)] });
    const root = await renderPage(cloudClient());
    expect(container.textContent).not.toContain("Invite people");
    await act(async () => root.unmount());

    listCloudStacksMock.mockResolvedValue({ stacks: [cloudStack("owner")] });
    const secondRoot = await renderPage(cloudClient(null));
    expect(container.textContent).not.toContain("Invite people");
    await act(async () => secondRoot.unmount());
  });
});
