// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CHAT_STARTER_PROMPTS,
  AgentChatEmptyState,
  agentChatRoleLine,
  agentChatSummaryLine,
} from "./AgentChatEmptyState";

const agent = {
  id: "agent-1",
  name: "Facet",
  role: "designer" as const,
  title: "UI Engineer",
  capabilities: "Builds landing pages and layouts. Works phone first.",
  appearance: null,
};

describe("AgentChatEmptyState", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("uses the title, else the role label, for the role line", () => {
    expect(agentChatRoleLine(agent)).toBe("UI Engineer");
    expect(agentChatRoleLine({ ...agent, title: null })).toBe("Designer");
  });

  it("keeps only the first sentence of the capabilities, with a fallback", () => {
    expect(agentChatSummaryLine(agent)).toBe("Builds landing pages and layouts.");
    expect(agentChatSummaryLine({ ...agent, capabilities: "  " })).toContain("Ask Facet");
  });

  it("shows the agent and sends a tapped starter prompt", () => {
    const onPrompt = vi.fn();
    const root = createRoot(container);
    act(() => root.render(<AgentChatEmptyState agent={agent} onPrompt={onPrompt} />));
    expect(container.textContent).toContain("Facet");
    expect(container.textContent).toContain("UI Engineer · Builds landing pages and layouts.");
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(AGENT_CHAT_STARTER_PROMPTS.length);
    act(() => buttons[1]!.click());
    expect(onPrompt).toHaveBeenCalledWith(AGENT_CHAT_STARTER_PROMPTS[1]);
    act(() => root.unmount());
  });
});
