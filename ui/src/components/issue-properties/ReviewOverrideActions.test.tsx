// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentBoardAccess } from "../../api/access";

const boardAccess = vi.hoisted(() => ({ current: null as CurrentBoardAccess | null }));
vi.mock("../../api/access", () => ({
  accessApi: { getCurrentBoardAccess: vi.fn(async () => boardAccess.current) },
}));

import { queryKeys } from "../../lib/queryKeys";
import { ReviewOverrideActions, canOverrideReviews } from "./ReviewOverrideActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function accessFor(membershipRole: "owner" | "admin", reviewOverrideCompanyIds: string[] = []): CurrentBoardAccess {
  return {
    user: null,
    userId: "viewer",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
    source: "session",
    keyId: null,
    reviewOverrideCompanyIds,
  };
}

const waitingOnBen = {
  companyId: "company-1",
  executionState: {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId: "ben" },
    returnAssignee: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  },
} as never;

describe("ReviewOverrideActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(access: CurrentBoardAccess, currentUserId = "viewer", onUpdate = vi.fn()) {
    boardAccess.current = access;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.access.currentBoardAccess, access);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ReviewOverrideActions issue={waitingOnBen} currentUserId={currentUserId} reviewerLabel="Ben" onUpdate={onUpdate} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {});
    return onUpdate;
  }

  const buttonLabels = () => Array.from(container.querySelectorAll("button")).map((button) => button.textContent);

  it("shows the actions to an owner", async () => {
    await render(accessFor("owner"));
    expect(buttonLabels()).toEqual(["Approve on their behalf", "Request changes on their behalf"]);
  });

  it("shows the actions to someone granted reviews:override", async () => {
    await render(accessFor("admin", ["company-1"]));
    expect(buttonLabels()).toContain("Approve on their behalf");
  });

  it("hides the actions from an admin without the grant", async () => {
    await render(accessFor("admin"));
    expect(container.textContent).toBe("");
  });

  it("hides the actions from the waiting reviewer", async () => {
    await render(accessFor("owner"), "ben");
    expect(container.textContent).toBe("");
  });

  it("asks for a reason before approving", async () => {
    const onUpdate = await render(accessFor("owner"));
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    const submitButton = () =>
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Approve")!;
    expect(submitButton().disabled).toBe(true);

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Checked it with Ben");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      submitButton().click();
    });
    expect(onUpdate).toHaveBeenCalledWith({ status: "done", reviewOverride: true, overrideReason: "Checked it with Ben" });
  });

  it("never lets a non-member override", () => {
    expect(canOverrideReviews("company-2", accessFor("owner"))).toBe(false);
  });
});
