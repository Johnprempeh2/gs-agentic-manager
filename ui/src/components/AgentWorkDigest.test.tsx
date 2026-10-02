// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentWorkDigest, AgentWorkDigestAgent, AgentWorkDigestCounts } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardDigestCardView,
  DigestAgentSection,
  SINCE_LAST_VISIT_PATH,
  digestCountsSentence,
  digestSinceLabel,
} from "./AgentWorkDigest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function counts(partial: Partial<AgentWorkDigestCounts> = {}): AgentWorkDigestCounts {
  return { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0, ...partial };
}

function agent(id: string, name: string, partial: Partial<AgentWorkDigestCounts> = {}): AgentWorkDigestAgent {
  return { agentId: id, agentName: name, counts: counts(partial), items: [] };
}

function digest(agents: AgentWorkDigestAgent[]): AgentWorkDigest {
  return {
    companyId: "company-1",
    since: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    sinceSource: "last_visit",
    generatedAt: new Date().toISOString(),
    counts: counts(),
    agents,
  };
}

describe("digestCountsSentence", () => {
  it("names only the kinds that happened, in plain words", () => {
    expect(digestCountsSentence(counts({ tasksFinished: 2, tasksStarted: 1, failures: 1 }))).toBe(
      "2 tasks finished, 1 started, 1 failed run",
    );
    expect(digestCountsSentence(counts({ tasksStarted: 1, decisionsRaised: 2 }))).toBe(
      "1 task started, 2 decisions for you",
    );
    expect(digestCountsSentence(counts())).toBe("No agent work");
  });
});

describe("digestSinceLabel", () => {
  it("says where the window starts", () => {
    expect(digestSinceLabel({ since: new Date().toISOString(), sinceSource: "default_window" })).toBe("In the last 24 hours");
    expect(digestSinceLabel(digest([]))).toBe("Since your last visit, 8h ago");
  });
});

describe("digest views", () => {
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

  it("home card: one line per agent, capped, with one link to the full view", () => {
    act(() => {
      root.render(
        <DashboardDigestCardView
          digest={digest([
            agent("a", "Ridge", { tasksFinished: 3 }),
            agent("b", "Mica", { tasksStarted: 1 }),
            agent("c", "Everest", { decisionsRaised: 1 }),
            agent("d", "Summit", { failures: 1 }),
          ])}
        />,
      );
    });
    const lines = Array.from(container.querySelectorAll('[aria-label="Agent work by agent"] li')).map((li) => li.textContent);
    expect(lines).toEqual([
      "Ridge:3 tasks finished",
      "Mica:1 task started",
      "Everest:1 decision for you",
      "and 1 more agent",
    ]);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(SINCE_LAST_VISIT_PATH);
    expect(link.textContent).toContain("See what happened");
  });

  it("home card: says so when nothing happened, and keeps the link", () => {
    act(() => {
      root.render(<DashboardDigestCardView digest={digest([])} />);
    });
    expect(container.textContent).toContain("No new agent work.");
    expect(container.querySelector(`a[href="${SINCE_LAST_VISIT_PATH}"]`)).not.toBeNull();
  });

  it("home card: shows the load error instead of an empty list", () => {
    act(() => {
      root.render(<DashboardDigestCardView digest={undefined} error={new Error("offline")} />);
    });
    expect(container.textContent).toContain("Could not load agent work: offline");
  });

  it("agent section links each line to its task and leaves task-less lines as text", () => {
    act(() => {
      root.render(
        <DigestAgentSection
          agent={{
            ...agent("a", "Ridge", { tasksFinished: 1, failures: 1 }),
            items: [
              {
                kind: "task_finished",
                label: "Finished GRE-12: Faster board",
                at: new Date().toISOString(),
                issueId: "issue-12",
                issueIdentifier: "GRE-12",
                runId: null,
              },
              {
                kind: "run_failed",
                label: "A run failed",
                at: new Date().toISOString(),
                issueId: null,
                issueIdentifier: null,
                runId: "run-1",
              },
            ],
          }}
        />,
      );
    });
    expect(container.querySelector("h2")?.textContent).toBe("Ridge");
    const rows = container.querySelectorAll('[aria-label="Ridge work"] li');
    expect(rows).toHaveLength(2);
    const link = rows[0].querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/issues/GRE-12");
    expect(link.textContent).toBe("Finished GRE-12: Faster board");
    expect(rows[1].querySelector("a")).toBeNull();
    expect(rows[1].textContent).toContain("A run failed");
  });
});
