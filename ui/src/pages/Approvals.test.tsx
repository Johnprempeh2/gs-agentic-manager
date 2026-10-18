// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";
import { approvalsApi } from "../api/approvals";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useActiveCompanyPrefix: () => null,
  useLocation: () => ({ pathname: "/approvals/pending" }),
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/approvals", () => ({ approvalsApi: { list: vi.fn(async () => []), approve: vi.fn(), reject: vi.fn() } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Approvals", () => {
  it("says in plain words what a sign-off is", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('[data-testid="approvals-intro"]')).toBeTruthy());
    });
    const intro = container.querySelector('[data-testid="approvals-intro"]')!;
    expect(intro.textContent).toContain("needs before it can go ahead");
    expect(intro.querySelector('[data-testid="help-term-approval"]')?.textContent).toBe("sign-off");
  });

  it("lets you tell the agent why when you reject, and confirms it", async () => {
    const now = new Date().toISOString();
    vi.mocked(approvalsApi.list).mockResolvedValue([
      { id: "approval-1", companyId: "company-1", type: "hire_agent", status: "pending", payload: { name: "Ada" }, requestedByAgentId: null, requestedByUserId: null, decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: now, updatedAt: now },
    ] as never);
    vi.mocked(approvalsApi.reject).mockResolvedValue({} as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    const findButton = (text: string) =>
      [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
    await act(async () => {
      await vi.waitFor(() => expect(findButton("Reject")).toBeTruthy());
    });
    await act(async () => {
      findButton("Reject")!.click();
    });
    const textarea = document.body.querySelector("textarea")!;
    expect(document.body.textContent).toContain("Tell the agent why (optional)");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "Not this month");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const dialogReject = [...document.body.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent?.trim() === "Reject") as HTMLButtonElement;
    await act(async () => {
      dialogReject.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith("approval-1", "Not this month"));
    });
    await act(async () => {
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Rejected" })));
    });
  });

  it("approves several ticked requests together", async () => {
    const now = new Date().toISOString();
    const pending = (id: string) => ({
      id,
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: { title: `Request ${id}` },
      requestedByAgentId: null,
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    vi.mocked(approvalsApi.list).mockResolvedValueOnce([pending("a1"), pending("a2"), pending("a3")] as never);
    vi.mocked(approvalsApi.approve).mockResolvedValue({} as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(container?.querySelector('[data-testid="approvals-select-bar"]')).toBeTruthy());
    });
    const tick = (id: string) => container!.querySelector(`[data-approval-select="${id}"]`) as HTMLButtonElement;
    await act(async () => {
      tick("a1").click();
    });
    await act(async () => {
      tick("a3").click();
    });
    const approveButton = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Approve selected")!;
    expect(approveButton.disabled).toBe(false);
    await act(async () => {
      approveButton.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledTimes(2));
    });
    expect(vi.mocked(approvalsApi.approve).mock.calls.map((call) => call[0])).toEqual(["a1", "a3"]);
  });
});
