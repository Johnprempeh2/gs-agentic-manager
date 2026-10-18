// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "@greatstone/shared";
import type { AskAgentInteraction } from "../lib/issue-thread-interactions";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const question: AskAgentInteraction = {
  id: "question-1",
  companyId: "company-1",
  issueId: "issue-1",
  kind: "ask_agent",
  status: "pending",
  continuationPolicy: "none",
  resolverPolicy: "not_creator",
  requestedResolverPolicy: "not_creator",
  effectiveResolverPolicy: "not_creator",
  resolverPolicyProvenance: "inherited",
  effectiveResolverPolicySource: "requested",
  legacyResolverPolicyAliases: { requested: null, effective: null },
  createdByAgentId: "agent-ada",
  createdByUserId: null,
  addresseeAgentId: "agent-grace",
  payload: { version: 1, question: "Which client contact signed the NDA?" },
  createdAt: "2026-10-16T10:00:00.000Z",
  updatedAt: "2026-10-16T10:00:00.000Z",
};

const agentMap = new Map<string, Agent>([
  ["agent-ada", { id: "agent-ada", name: "Ada" } as Agent],
  ["agent-grace", { id: "agent-grace", name: "Grace" } as Agent],
]);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(interaction: AskAgentInteraction) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <TooltipProvider>
        <ThemeProvider>
          <IssueThreadInteractionCard interaction={interaction} agentMap={agentMap} />
        </ThemeProvider>
      </TooltipProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentQuestionCard", () => {
  it("shows who was asked and that the answer is awaited", () => {
    const node = render(question);
    expect(node.textContent).toContain("Asked Grace:");
    expect(node.textContent).toContain("Which client contact signed the NDA?");
    expect(node.textContent).toContain("Asked by Ada");
    expect(node.textContent).toContain("Waiting for Grace to answer");
    expect(node.querySelector("button")).toBeNull();
  });

  it("shows the answer underneath once given", () => {
    const node = render({
      ...question,
      status: "answered",
      resolvedByAgentId: "agent-grace",
      result: { version: 1, outcome: "answered", answer: "Jane Smith signed it." },
    });
    expect(node.textContent).toContain("Asked Grace:");
    expect(node.textContent).toContain("Answer from Grace");
    expect(node.textContent).toContain("Jane Smith signed it.");
    expect(node.textContent).not.toContain("Waiting for Grace");
  });

  it("says plainly when the question closed without an answer", () => {
    const node = render({
      ...question,
      status: "cancelled",
      result: { version: 1, outcome: "withdrawn", reason: null },
    });
    expect(node.textContent).toContain("Question withdrawn before it was answered");
  });
});
