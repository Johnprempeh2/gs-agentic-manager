// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewGoalDialog } from "./NewGoalDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(() => {
    callback();
  });
}

const dialogState = vi.hoisted(() => ({ parentId: undefined as string | undefined }));

vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() } }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newGoalOpen: true,
    newGoalDefaults: { parentId: dialogState.parentId },
    closeNewGoal: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Greatstone", issuePrefix: "GRE" },
  }),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="markdown-editor" />,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialogState.parentId = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <NewGoalDialog />
      </QueryClientProvider>,
    );
  });
}

/** Accessible name of the dialog, resolved from aria-labelledby as a screen reader would. */
function dialogName() {
  const dialog = document.querySelector('[role="dialog"]');
  const labelId = dialog?.getAttribute("aria-labelledby");
  return labelId ? document.getElementById(labelId)?.textContent?.trim() : undefined;
}

describe("NewGoalDialog", () => {
  it("opens as a dialog named New goal", () => {
    render();
    expect(dialogName()).toMatch(/new goal/i);
  });

  it("names a sub-goal dialog New sub-goal", () => {
    dialogState.parentId = "goal-1";
    render();
    expect(dialogName()).toMatch(/new sub-goal/i);
  });
});
