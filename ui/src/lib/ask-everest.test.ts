import { describe, expect, it } from "vitest";
import type { AgentWorkDigest, Issue, NeedsMe, TeamScorecard } from "@greatstone/shared";
import {
  answerAway,
  answerAgent,
  answerDecide,
  answerStuck,
  answerSubject,
  classifyQuestion,
  questionSubject,
} from "./ask-everest";

const agents = [
  { id: "everest", name: "Everest", status: "idle" },
  { id: "mason", name: "Mason", status: "running" },
];

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "i1",
    identifier: "GRE-1",
    title: "Task",
    status: "todo",
    assigneeAgentId: null,
    updatedAt: new Date("2026-10-16T09:00:00Z"),
    ...overrides,
  } as Issue;
}

describe("classifyQuestion", () => {
  it("spots decision questions", () => {
    expect(classifyQuestion("What do I need to decide?", agents)).toEqual({ kind: "decide" });
    expect(classifyQuestion("what is required from us", agents)).toEqual({ kind: "decide" });
  });

  it("spots stuck questions and keeps the subject", () => {
    expect(classifyQuestion("What is stuck on the Indago work?", agents)).toEqual({ kind: "stuck", subject: "Indago" });
    expect(classifyQuestion("Anything blocked?", agents)).toEqual({ kind: "stuck", subject: null });
  });

  it("spots questions about an agent", () => {
    expect(classifyQuestion("What did Mason do today?", agents)).toEqual({
      kind: "agent",
      agentId: "mason",
      agentName: "Mason",
      window: "today",
    });
    expect(classifyQuestion("what has mason done this week", agents)).toMatchObject({ kind: "agent", window: "week" });
  });

  it("falls back to a subject, then an overview", () => {
    expect(classifyQuestion("How is the Pipedrive import going?", agents)).toEqual({ kind: "subject", subject: "Pipedrive import" });
    expect(classifyQuestion("How are we doing?", agents)).toEqual({ kind: "overview" });
  });

  it("strips question words from the subject", () => {
    expect(questionSubject("What's the latest on the booking module?")).toBe("booking module");
  });
});

describe("answers", () => {
  it("says nothing needs you when Needs you is empty", () => {
    const empty = { count: 0, decisionCount: 0, assignedTaskCount: 0, decisions: [], assignedTasks: [], overdueWaits: [] } as unknown as NeedsMe;
    expect(answerDecide(empty).headline).toMatch(/Nothing needs you/);
  });

  it("counts decisions and lists them with their reason", () => {
    const needsMe = {
      count: 2,
      decisionCount: 1,
      assignedTaskCount: 1,
      decisions: [{ id: "task:i1", title: "Approve the Indago fee", reason: "Fixed fee or day rate", task: { id: "i1", identifier: "GRE-9" } }],
      assignedTasks: [{ id: "i2", identifier: "GRE-10", title: "Review the deck", status: "in_review", priority: "high", updatedAt: "" }],
      overdueWaits: [],
    } as unknown as NeedsMe;
    const answer = answerDecide(needsMe);
    expect(answer.headline).toBe("2 things need you: 1 decision, 1 task assigned to you.");
    expect(answer.lines[0]).toEqual({ text: "Approve the Indago fee", detail: "Fixed fee or day rate", href: "/issues/GRE-9" });
    expect(answer.lines[1]?.detail).toBe("Assigned to you, waiting for review");
  });

  it("names the blocker and owner of stuck tasks", () => {
    const stuck = issue({
      status: "blocked",
      title: "Indago kick-off pack",
      assigneeAgentId: "mason",
      blockedBy: [{ id: "i9", identifier: "GRE-9", title: "Approve the fee", status: "todo" }] as Issue["blockedBy"],
    });
    const answer = answerStuck([stuck], "indago", (id) => (id === "mason" ? "Mason" : null));
    expect(answer.headline).toBe("1 task is stuck on indago.");
    expect(answer.lines[0]?.detail).toBe("Waiting on GRE-9: Approve the fee. With Mason.");
  });

  it("summarises what an agent did today", () => {
    const now = new Date("2026-10-16T18:00:00");
    const scorecard = {
      days: 7,
      totals: { finished: 0, underWay: 0, inReview: 0, stuck: 0, overdue: 0 },
      agents: [{ agentId: "mason", name: "Mason", underWay: 2, inReview: 1, stuck: 0, stuckTasks: [], finished: 3, recentlyFinished: [] }],
    } as unknown as TeamScorecard;
    const answer = answerAgent(
      { id: "mason", name: "Mason" },
      "today",
      scorecard,
      [
        issue({ id: "a", identifier: "GRE-1", status: "done", updatedAt: new Date("2026-10-16T10:00:00") }),
        issue({ id: "b", identifier: "GRE-2", status: "in_progress", updatedAt: new Date("2026-10-16T11:00:00") }),
        issue({ id: "c", identifier: "GRE-3", status: "done", updatedAt: new Date("2026-10-14T11:00:00") }),
      ],
      now,
    );
    expect(answer.headline).toBe("Mason worked on 2 tasks today and finished 1. Right now: 2 under way, 1 waiting for review.");
  });

  it("puts stuck tasks first when answering about a subject", () => {
    const answer = answerSubject("indago", [
      issue({ id: "a", title: "Draft proposal", status: "in_progress" }),
      issue({ id: "b", title: "Kick-off pack", status: "blocked" }),
      issue({ id: "c", title: "Intro call", status: "done" }),
    ]);
    expect(answer.headline).toBe("3 tasks about indago: 2 open, 1 stuck, 1 done.");
    expect(answer.lines[0]?.text).toBe("Kick-off pack");
  });
});

describe("since you were away", () => {
  it("spots catch-up questions before decision questions", () => {
    expect(classifyQuestion("What happened since I was last here?", agents)).toEqual({ kind: "away" });
    expect(classifyQuestion("what did I miss", agents)).toEqual({ kind: "away" });
    expect(classifyQuestion("catch me up on what needs me", agents)).toEqual({ kind: "away" });
  });

  const since = "2026-10-16T01:00:00Z";
  const digest = {
    companyId: "c1",
    since,
    sinceSource: "default_window",
    generatedAt: "2026-10-16T09:00:00Z",
    counts: { tasksFinished: 2, tasksStarted: 0, decisionsRaised: 0, failures: 1 },
    agents: [{
      agentId: "mason",
      agentName: "Mason",
      counts: { tasksFinished: 2, tasksStarted: 0, decisionsRaised: 0, failures: 1 },
      items: [
        { kind: "task_finished", label: "Finished GRE-4: Indago pack", at: "2026-10-16T05:00:00Z", issueId: "i4", issueIdentifier: "GRE-4", runId: null },
        { kind: "run_failed", label: "Run failed", at: "2026-10-16T04:00:00Z", issueId: null, issueIdentifier: null, runId: "r1" },
      ],
    }],
  } as AgentWorkDigest;

  it("says what finished, what got stuck and what needs you", () => {
    const blocked = [
      issue({ id: "b1", identifier: "GRE-8", title: "Chase fee", status: "blocked", updatedAt: new Date("2026-10-16T03:00:00Z") }),
      issue({ id: "b2", identifier: "GRE-2", title: "Old block", status: "blocked", updatedAt: new Date("2026-10-15T03:00:00Z") }),
    ];
    const needsMe = {
      count: 1, decisionCount: 1, assignedTaskCount: 0, overdueWaits: [], assignedTasks: [],
      decisions: [{ id: "d1", title: "Approve the fee", reason: "Fixed or day rate", task: { id: "i9", identifier: "GRE-9" } }],
    } as unknown as NeedsMe;
    const answer = answerAway(digest, blocked, needsMe);
    expect(answer.headline).toBe("In the last 24 hours: 2 tasks finished, 1 got stuck, 1 thing needs you, 1 run failed.");
    expect(answer.lines.map((line) => line.text)).toEqual(["Approve the fee", "Chase fee", "Finished GRE-4: Indago pack"]);
    expect(answer.more?.href).toBe("/since-last-visit");
  });

  it("says plainly when nothing happened", () => {
    const quiet = { ...digest, counts: { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0 }, agents: [] };
    expect(answerAway(quiet, [], null).headline).toBe(
      "In the last 24 hours: nothing new. Nothing finished, nothing got stuck and nothing needs you.",
    );
  });
});
