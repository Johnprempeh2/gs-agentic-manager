// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, ConnectionGrant } from "@greatstone/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareWithAgentsSection } from "./ShareWithAgentsSection";
const { share, unshare } = vi.hoisted(() => ({ share: vi.fn(async () => null), unshare: vi.fn(async () => null) }));
vi.mock("@/api/tools", () => ({ toolsApi: { createConnectionGrantDelegation: share, revokeConnectionGrantDelegation: unshare } }));
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); vi.clearAllMocks(); });
async function render(status = "active") {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const grant = { id: "grant", kind: "user", subjectUserId: "owner", status,
    delegations: [{ id: "delegation-keystone", agentId: "keystone", grantId: "grant" }] } as unknown as ConnectionGrant;
  const agents = [{ id: "keystone", name: "Keystone", status: "idle" }, { id: "ridge", name: "Ridge", status: "idle" },
    { id: "gone", name: "Gone", status: "terminated" }] as unknown as Agent[];
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <ShareWithAgentsSection connectionId="connection" grant={grant} agents={agents} />
  </QueryClientProvider>));
}
const box = (name: string) => container.querySelector<HTMLButtonElement>(`[id$="-${name}"]`)!;
describe("Share with agents", () => {
  it("shows current shares and shares or unshares through the delegation API", async () => {
    await render();
    expect(container.textContent).toContain("Agents you tick can use your GitHub for work they start themselves.");
    expect(container.textContent).not.toContain("Gone");
    expect(box("keystone").getAttribute("data-state")).toBe("checked");
    expect(box("ridge").getAttribute("data-state")).toBe("unchecked");
    await act(async () => box("ridge").click());
    expect(share).toHaveBeenCalledWith("connection", "grant", "ridge");
    await act(async () => box("keystone").click());
    expect(unshare).toHaveBeenCalledWith("connection", "grant", "delegation-keystone");
  });
  it("asks for a reconnect instead of sharing an inactive grant", async () => {
    await render("needs_reauthorization");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("Reconnect your GitHub account to share it.");
  });
});
