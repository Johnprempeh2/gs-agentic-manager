// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const list = vi.fn(async () => [{ key: "onboard-a-client" }]);
const create = vi.fn(async (..._args: unknown[]) => ({ id: "t1" }));
const pushToast = vi.fn();
vi.mock("../api/workflowTemplates", () => ({
  workflowTemplatesApi: { list: () => list(), create: (...args: unknown[]) => create(...args) },
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));

import { SaveAsWorkflowDialog } from "./SaveAsWorkflowDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("SaveAsWorkflowDialog", () => {
  it("lists the steps and saves with a key that does not clash", async () => {
    const onOpenChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SaveAsWorkflowDialog
            open
            onOpenChange={onOpenChange}
            companyId="company-1"
            task={{ title: "Onboard a client" }}
            subtasks={[
              { id: "a", title: "Kick-off call", createdAt: "2026-10-01T00:00:00Z" },
              { id: "b", title: "Send welcome pack", createdAt: "2026-10-02T00:00:00Z", blockedBy: [{ id: "a" }] },
            ]}
          />
        </QueryClientProvider>,
      );
    });
    expect(document.querySelector("[data-testid='save-as-workflow-steps']")?.textContent).toContain("Send welcome pack");
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save workflow")!;
    await act(async () => {
      save.click();
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [companyId, body] = create.mock.calls[0] as [string, { key: string; name: string; definition: { steps: { key: string }[] } }];
    expect(companyId).toBe("company-1");
    expect(body.key).toBe("onboard-a-client-2");
    expect(body.name).toBe("Onboard a client");
    expect(body.definition.steps.map((step) => step.key)).toEqual(["kick-off-call", "send-welcome-pack"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Saved as a workflow" }));
  });
});
