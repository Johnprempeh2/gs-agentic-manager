// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/approvals/pending" }),
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/approvals", () => ({ approvalsApi: { list: vi.fn(async () => []), approve: vi.fn(), reject: vi.fn() } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));

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
});
