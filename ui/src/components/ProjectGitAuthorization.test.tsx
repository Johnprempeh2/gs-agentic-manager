// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectGitAuthorization } from "./ProjectGitAuthorization";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectsApi = vi.hoisted(() => ({ gitAuthorization: vi.fn(), setGitAuthorization: vi.fn() }));
const accessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
vi.mock("@/api/projects", () => ({ projectsApi }));
vi.mock("@/api/access", () => ({ accessApi }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));

const personal = { grantId: "grant-1", connectionName: "My Connector", login: "writer" };
const other = { grantId: "grant-2", connectionName: "Second Connector", login: "writer-2" };

describe("ProjectGitAuthorization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    accessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "writer-1", source: "session", memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }],
    });
    projectsApi.gitAuthorization.mockResolvedValue({ grantId: null, authorizedByUserId: null, options: [personal, other] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ProjectGitAuthorization companyId="company-1" projectId="project-1" />
    </QueryClientProvider>));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function chooseGrant(id: string) {
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes(label));
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
  }

  it("requires explicit consent and shows the server-confirmed selection", async () => {
    projectsApi.setGitAuthorization.mockResolvedValue({ grantId: personal.grantId, authorizedByUserId: "writer-1", options: [personal, other] });
    await render();
    await chooseGrant(personal.grantId);
    expect(container.textContent).toContain("No grant selected");
    const allow = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes("Allow background Git"))!;
    expect(allow.disabled).toBe(true);
    expect(container.querySelector('input[type="checkbox"]')?.closest("label")?.textContent)
      .toContain("private repositories linked to this project");
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(allow.disabled).toBe(false);
    await click("Allow background Git");
    expect(projectsApi.setGitAuthorization).toHaveBeenCalledWith("project-1", "company-1", personal.grantId);
    expect(container.textContent).toContain("Your consent is recorded for My Connector (writer)");
  });

  it("revokes a grant selected by another writer even when their grant is unavailable here", async () => {
    projectsApi.gitAuthorization.mockResolvedValue({ grantId: "someone-else-grant", authorizedByUserId: "writer-2", options: [personal] });
    projectsApi.setGitAuthorization.mockResolvedValue({ grantId: null, authorizedByUserId: null, options: [personal] });
    await render();
    expect(container.textContent).toContain("selected by another writer");
    expect(container.textContent).not.toContain("someone-else-grant");
    await click("Revoke project grant");
    expect(projectsApi.setGitAuthorization).toHaveBeenCalledWith("project-1", "company-1", null);
    expect(container.textContent).toContain("No grant selected");
  });

  it("keeps the saved state after a failed selection or revoke and allows retry", async () => {
    projectsApi.setGitAuthorization.mockRejectedValueOnce(new Error("Server unavailable"))
      .mockResolvedValueOnce({ grantId: personal.grantId, authorizedByUserId: "writer-1", options: [personal] })
      .mockRejectedValueOnce(new Error("Server unavailable"));
    await render();
    await chooseGrant(personal.grantId);
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await click("Allow background Git");
    expect(container.textContent).toContain("No grant selected");
    expect(container.textContent).toContain("Consent was not changed. Server unavailable");
    await click("Allow background Git");
    expect(container.textContent).toContain("Your consent is recorded");
    await click("Revoke project grant");
    expect(container.textContent).toContain("Your consent is recorded");
    expect(container.textContent).toContain("Consent was not changed. Server unavailable");
  });

  it("shows the empty grant path and does not load grants for a viewer", async () => {
    projectsApi.gitAuthorization.mockResolvedValue({ grantId: "old-grant", authorizedByUserId: "writer-1", options: [] });
    await render();
    expect(container.textContent).toContain("no longer in your eligible options");
    expect(container.textContent).toContain("Connect GitHub in Apps");
    expect(container.querySelector('a[href="/apps"]')).not.toBeNull();
    expect(container.textContent).toContain("Revoke project grant");

    client.clear();
    accessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "viewer", source: "session", memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ProjectGitAuthorization companyId="company-1" projectId="project-2" />
    </QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Sign in as a project writer");
    expect(projectsApi.gitAuthorization).toHaveBeenCalledTimes(1);
  });

  it("reports a failed load and recovers when the writer retries", async () => {
    projectsApi.gitAuthorization.mockRejectedValueOnce(new Error("Could not load grants"))
      .mockResolvedValueOnce({ grantId: null, authorizedByUserId: null, options: [personal] });
    await render();
    expect(container.textContent).toContain("GitHub grants did not load");
    expect(container.textContent).not.toContain("No grant selected");
    await click("Try again");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(projectsApi.gitAuthorization).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("No grant selected");
  });
});
