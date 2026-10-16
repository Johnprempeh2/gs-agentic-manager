// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dialogState = { newIssueOpen: false, newProjectOpen: false, newGoalOpen: false, newAgentOpen: false, onboardingOpen: false };
let pathname = "/GRE/inbox";

vi.mock("../context/DialogContext", () => ({ useDialog: () => dialogState }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname }) }));
vi.mock("./NewIssueDialog", () => ({ NewIssueDialog: () => <div>NEW_TASK_FORM</div> }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => <div>NEW_PROJECT_FORM</div> }));
vi.mock("./NewGoalDialog", () => ({ NewGoalDialog: () => <div>NEW_GOAL_FORM</div> }));
vi.mock("./NewAgentDialog", () => ({ NewAgentDialog: () => <div>NEW_AGENT_FORM</div> }));
vi.mock("./OnboardingWizardVariant", () => ({ OnboardingWizardVariant: () => <div>ONBOARDING</div> }));

const { OnDemandCreateDialogs, OnDemandOnboarding } = await import("./OnDemandDialogs");

describe("on-demand dialogs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(dialogState, { newIssueOpen: false, newProjectOpen: false, newGoalOpen: false, newAgentOpen: false, onboardingOpen: false });
    pathname = "/GRE/inbox";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads a create form only once it is opened, then keeps it mounted", async () => {
    await act(async () => root.render(<OnDemandCreateDialogs />));
    expect(container.textContent).toBe("");

    dialogState.newIssueOpen = true;
    await act(async () => root.render(<OnDemandCreateDialogs />));
    await vi.waitFor(() => expect(container.textContent).toContain("NEW_TASK_FORM"));
    expect(container.textContent).not.toContain("NEW_PROJECT_FORM");

    dialogState.newIssueOpen = false;
    await act(async () => root.render(<OnDemandCreateDialogs />));
    expect(container.textContent).toContain("NEW_TASK_FORM");
  });

  it("loads onboarding for an onboarding link even when the dialog is closed", async () => {
    await act(async () => root.render(<OnDemandOnboarding />));
    expect(container.textContent).toBe("");

    pathname = "/onboarding";
    await act(async () => root.render(<OnDemandOnboarding />));
    await vi.waitFor(() => expect(container.textContent).toContain("ONBOARDING"));
  });
});
