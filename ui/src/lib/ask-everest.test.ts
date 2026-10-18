import { describe, expect, it } from "vitest";
import type { AgentWorkDigest, Issue, NeedsMe, TeamScorecard } from "@greatstone/shared";
import {
  answerAway,
  answerAgent,
  answerDecide,
  answerHistory,
  answerPeople,
  answerQuiet,
  answerClosing,
  answerPipeline,
  answerResults,
  SALES_QUESTIONS,
  closingDays,
  answerActivity,
  answerBrief,
  quietDays,
  answerStuck,
  answerSubject,
  organisationAskContext,
  answerFollowUp,
  classifyQuestion,
  followUpRefinement,
  intentWithContext,
  liveQuestionText,
  narrowTasks,
  pipelineItemAskContext,
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

  it("spots questions about past conversations with a client", () => {
    expect(classifyQuestion("When did we last speak to Acme?", agents)).toEqual({ kind: "history", subject: "Acme" });
    expect(classifyQuestion("What did we last discuss with Acme Ltd?", agents)).toEqual({ kind: "history", subject: "Acme Ltd" });
    expect(classifyQuestion("Any notes from the Indago call?", agents)).toEqual({ kind: "history", subject: "Indago" });
    expect(classifyQuestion("What did we discuss?", agents)).toEqual({ kind: "history", subject: null });
    expect(classifyQuestion("What did Mason do today?", agents)).toMatchObject({ kind: "agent" });
  });

  it("spots questions about clients that have gone quiet", () => {
    expect(classifyQuestion("Which clients have gone quiet?", agents)).toEqual({ kind: "quiet", days: 30 });
    expect(classifyQuestion("Who haven't we spoken to in 2 weeks?", agents)).toEqual({ kind: "quiet", days: 14 });
    expect(classifyQuestion("Which deals should we chase?", agents)).toEqual({ kind: "quiet", days: 30 });
    expect(quietDays("not heard from in 3 months")).toBe(90);
    expect(quietDays("gone quiet for a fortnight")).toBe(14);
  });

  it("spots questions about recent client calls and meetings with no client named", () => {
    expect(classifyQuestion("What calls did we have this week?", agents)).toEqual({ kind: "activity", days: 7 });
    expect(classifyQuestion("Any client meetings today?", agents)).toEqual({ kind: "activity", days: 1 });
    expect(classifyQuestion("What did we discuss with Acme this week?", agents)).toEqual({ kind: "history", subject: "Acme" });
    expect(intentWithContext({ kind: "history", subject: null }, null)).toEqual({ kind: "activity", days: 7 });
    expect(intentWithContext({ kind: "activity", days: 7 }, { label: "Acme Ltd", summary: "", subject: "Acme Ltd" })).toEqual({ kind: "history", subject: "Acme Ltd" });
  });

  it("spots requests for a brief on an organisation", () => {
    expect(classifyQuestion("Tell me about Grebe", agents)).toEqual({ kind: "brief", subject: "Grebe" });
    expect(classifyQuestion("What do we know about Indago Mining?", agents)).toEqual({ kind: "brief", subject: "Indago Mining" });
    expect(classifyQuestion("Tell me about Mason", agents)).toMatchObject({ kind: "agent" });
    expect(intentWithContext({ kind: "brief", subject: null }, { label: "Acme Ltd", summary: "", subject: "Acme Ltd" })).toEqual({ kind: "brief", subject: "Acme Ltd" });
    expect(intentWithContext({ kind: "brief", subject: null }, null)).toEqual({ kind: "overview" });
  });

  it("spots questions about who we know at a client", () => {
    expect(classifyQuestion("Who is our contact at Acme?", agents)).toEqual({ kind: "people", subject: "Acme" });
    expect(classifyQuestion("Who do we know at Indago Mining?", agents)).toEqual({ kind: "people", subject: "Indago Mining" });
    expect(classifyQuestion("Email address for the Acme decision maker", agents)).toEqual({ kind: "people", subject: "Acme" });
    expect(classifyQuestion("Who is working on the Indago work?", agents)).toEqual({ kind: "subject", subject: "Indago" });
  });

  it("strips question words from the subject", () => {
    expect(questionSubject("What's the latest on the booking module?")).toBe("booking module");
  });
});

describe("answers", () => {
  it("briefs on an organisation in one line, then deals and people", () => {
    const answer = answerBrief("grebe", {
      organisation: { id: "o1", name: "Grebe", status: "client", industry: "Mining", country: "Ghana", href: "/GRE/organisations/o1" },
      people: [{ name: "Yaw Darko", role: "CFO", email: "yaw@example.com" }],
      peopleCount: 2,
      openDeals: [{ title: "Grebe expansion", stageName: "Proposal", pipelineName: "Sales", href: "/GRE/pipelines/p/items/c1" }],
      lastTouch: { at: "2026-10-08T09:00:00.000Z", label: "Meeting: Quarterly review" },
      quietDays: 10,
    });
    expect(answer.headline).toBe("Grebe: client, Mining, Ghana. 1 open deal, 2 people, last contact 10 days ago (Meeting: Quarterly review).");
    expect(answer.lines).toEqual([
      { text: "Grebe expansion", detail: "Open deal: Proposal in Sales", href: "/GRE/pipelines/p/items/c1" },
      { text: "Yaw Darko", detail: "CFO, yaw@example.com", href: "/GRE/organisations/o1" },
    ]);
    expect(answer.more).toEqual({ label: "Open Grebe", href: "/GRE/organisations/o1" });
    expect(answerBrief("Nobody", null).headline).toBe("I could not find an organisation called Nobody.");
  });

  it("sums up recent client contact by kind", () => {
    const answer = answerActivity({
      days: 7,
      total: 3,
      clientCount: 2,
      byKind: [["Call", 2], ["Note", 1]],
      activity: [{ id: "a1", kindLabel: "Call", title: "Pricing call", clientName: "Heron Ltd", ownerName: "Ama", occurredAt: new Date().toISOString(), href: "/GRE/organisations/o1" }],
    });
    expect(answer.headline).toBe("3 notes, calls and meetings with 2 clients this week: 2 calls, 1 note.");
    expect(answer.lines[0]).toMatchObject({ text: "Pricing call", href: "/GRE/organisations/o1" });
    expect(answer.lines[0]!.detail).toMatch(/^Call, Heron Ltd, Ama, /);
    expect(answerActivity({ days: 1, total: 0, clientCount: 0, byKind: [], activity: [] }).headline).toBe("No notes, calls or meetings with clients today.");
  });

  it("lists quiet deals, quietest first, or says everyone is in touch", () => {
    const answer = answerQuiet({
      days: 30,
      total: 3,
      clients: [
        { caseId: "c1", title: "Heron rollout", pipelineId: "p", pipelineName: "Sales", stageName: "Proposal", organisationName: "Heron Ltd", lastTouchAt: "2026-08-29T09:00:00.000Z", lastTouchLabel: "Call: Pricing call", quietDays: 50, href: "/GRE/pipelines/p/items/c1" },
        { caseId: "c2", title: "Wren lead", pipelineId: "p", pipelineName: "Sales", stageName: "Proposal", organisationName: null, lastTouchAt: null, lastTouchLabel: null, quietDays: 47, href: "/GRE/pipelines/p/items/c2" },
      ],
    });
    expect(answer.headline).toBe("3 open deals and leads had no note, call or meeting in 30 days. The quietest is Heron rollout (50 days).");
    expect(answer.lines[0]).toEqual({ text: "Heron rollout", detail: "Proposal in Sales, last Call: Pricing call, 50 days ago", href: "/GRE/pipelines/p/items/c1" });
    expect(answer.lines[1]!.detail).toBe("Proposal in Sales, no notes or calls yet, added 47 days ago");
    expect(answerQuiet({ days: 30, total: 0, clients: [] }).headline).toBe("Every open deal and lead has had a note, call or meeting in the last 30 days.");
  });

  it("spots questions about deals closing soon or past their date", () => {
    expect(classifyQuestion("Which deals are closing this month?", agents)).toEqual({ kind: "closing", days: 30 });
    expect(classifyQuestion("What is closing this week?", agents)).toEqual({ kind: "closing", days: 7 });
    expect(classifyQuestion("How much is in the pipeline this quarter?", agents)).toEqual({ kind: "closing", days: 90 });
    expect(classifyQuestion("Which deals have slipped?", agents)).toEqual({ kind: "closing", days: 0 });
    expect(classifyQuestion("Which leads are past their close date?", agents)).toEqual({ kind: "closing", days: 0 });
    expect(closingDays("expected to close in 2 weeks")).toBe(14);
    expect(classifyQuestion("What is Mason closing today?", agents).kind).toBe("agent");
  });

  it("answers every client and deal chip with its own intent", () => {
    expect(SALES_QUESTIONS.map((question) => classifyQuestion(question, agents).kind)).toEqual(["closing", "pipeline", "results", "pipeline"]);
  });

  it("spots questions about deals won and lost", () => {
    expect(classifyQuestion("What did we win this month?", agents)).toEqual({ kind: "results", days: 30 });
    expect(classifyQuestion("Which deals did we lose this quarter?", agents)).toEqual({ kind: "results", days: 90 });
    expect(classifyQuestion("Why are we losing deals?", agents)).toEqual({ kind: "results", days: 30 });
    expect(classifyQuestion("Any wins this week?", agents)).toEqual({ kind: "results", days: 7 });
  });

  it("sums up wins and losses with the main lost reason", () => {
    const deal = (title: string, closedOn: string, extra: object = {}) => ({ caseId: title, title, pipelineName: "Sales", organisationName: null, closedOn, value: null, currency: null, lostReason: null, href: `/GRE/pipelines/p/items/${title}`, ...extra });
    const answer = answerResults({
      days: 30,
      won: { count: 2, valueByCurrency: [{ currency: "GBP", value: 5000 }], deals: [deal("Recent win", "2026-10-15", { value: 1000, currency: "GBP", organisationName: "Heron Ltd" })] },
      lost: { count: 3, valueByCurrency: [], deals: [deal("Lost again", "2026-10-12", { lostReason: "Price" })], reasons: [{ reason: "Price", count: 2 }] },
    });
    expect(answer.headline).toBe("Won 2 deals worth GBP 5,000 and lost 3 this month. The most common lost reason is Price (2).");
    expect(answer.lines.map((line) => line.detail)).toEqual(["Won 15 Oct, GBP 1,000, Heron Ltd", "Lost 12 Oct, Price"]);
    expect(answerResults({ days: 7, won: { count: 0, valueByCurrency: [], deals: [] }, lost: { count: 0, valueByCurrency: [], deals: [], reasons: [] } }).headline).toBe("No deals or leads were won or lost this week.");
  });

  it("spots questions about the pipeline as a whole", () => {
    expect(classifyQuestion("How is the pipeline looking?", agents)).toEqual({ kind: "pipeline", view: "stages" });
    expect(classifyQuestion("What are our biggest deals?", agents)).toEqual({ kind: "pipeline", view: "stages" });
    expect(classifyQuestion("How much is in the pipeline?", agents)).toEqual({ kind: "pipeline", view: "stages" });
    expect(classifyQuestion("Who has the most deals?", agents)).toEqual({ kind: "pipeline", view: "owners" });
    expect(classifyQuestion("Show me deals by owner", agents)).toEqual({ kind: "pipeline", view: "owners" });
  });

  it("sums up the pipeline by stage and names the largest deal", () => {
    const answer = answerPipeline({
      total: 4,
      valueByCurrency: [{ currency: "GBP", value: 9100, count: 2 }, { currency: "USD", value: 3000, count: 1 }, { currency: null, value: 0, count: 1 }],
      stages: [
        { pipelineId: "p", pipelineName: "Sales", stageName: "Lead", count: 1, valueByCurrency: [{ currency: "GBP", value: 100 }] },
        { pipelineId: "p", pipelineName: "Sales", stageName: "Proposal", count: 3, valueByCurrency: [{ currency: "GBP", value: 9000 }, { currency: "USD", value: 3000 }] },
      ],
      topDeals: [{ caseId: "c1", title: "Big proposal", pipelineName: "Sales", stageName: "Proposal", organisationName: null, value: 9000, currency: "GBP", expectedCloseDate: "2026-11-01", href: "/GRE/pipelines/p/items/c1" }],
      owners: [
        { owner: "Kofi", count: 3, valueByCurrency: [{ currency: "GBP", value: 9000 }] },
        { owner: null, count: 1, valueByCurrency: [] },
      ],
    });
    expect(answer.headline).toBe("4 open deals and leads worth GBP 9,100 and USD 3,000. Most are in Proposal (3); the largest is Big proposal at GBP 9,000.");
    expect(answer.lines[1]).toEqual({ text: "Proposal", detail: "3 open deals, GBP 9,000, USD 3,000", href: "/pipelines" });
    expect(answer.lines[2]).toEqual({ text: "Big proposal", detail: "GBP 9,000, Proposal in Sales, due 1 Nov", href: "/GRE/pipelines/p/items/c1" });
    const byOwner = answerPipeline({ total: 4, valueByCurrency: [], stages: [], topDeals: [], owners: [{ owner: "Kofi", count: 3, valueByCurrency: [{ currency: "GBP", value: 9000 }] }, { owner: null, count: 1, valueByCurrency: [] }] }, "owners");
    expect(byOwner.headline).toBe("4 open deals and leads across 1 owner. Kofi has the most (3, GBP 9,000).");
    expect(byOwner.lines.map((line) => [line.text, line.detail])).toEqual([["Kofi", "3 open deals, GBP 9,000"], ["No owner", "1 open deal"]]);
    expect(answerPipeline({ total: 0, valueByCurrency: [], stages: [], topDeals: [], owners: [] }).headline).toBe("There are no open deals or leads in any pipeline.");
  });

  it("lists deals by close date with value per currency, or says none are due", () => {
    const answer = answerClosing({
      days: 30,
      total: 3,
      overdueCount: 1,
      valueByCurrency: [{ currency: "GBP", value: 7500, count: 2 }, { currency: null, value: 0, count: 1 }],
      deals: [
        { caseId: "c1", title: "Late renewal", pipelineName: "Sales", stageName: "Proposal", organisationName: null, expectedCloseDate: "2026-10-10", overdue: true, value: 5000, currency: "GBP", href: "/GRE/pipelines/p/items/c1" },
        { caseId: "c2", title: "Wren lead", pipelineName: "Sales", stageName: "Qualified", organisationName: null, expectedCloseDate: "2026-10-25", overdue: false, value: null, currency: null, href: "/GRE/pipelines/p/items/c2" },
      ],
    });
    expect(answer.headline).toBe("3 open deals and leads closing this month, worth GBP 7,500. 1 is already past the date.");
    expect(answer.lines[0]).toEqual({ text: "Late renewal", detail: "Was due 10 Oct, GBP 5,000, Proposal in Sales", href: "/GRE/pipelines/p/items/c1" });
    expect(answer.lines[1]!.detail).toBe("Due 25 Oct, Qualified in Sales");
    expect(answerClosing({ days: 0, total: 0, overdueCount: 0, valueByCurrency: [], deals: [] }).headline).toBe("No open deals or leads are past their expected close date.");
    expect(answerClosing({ days: 7, total: 0, overdueCount: 0, valueByCurrency: [], deals: [] }).headline).toBe("No open deals or leads have an expected close date in the next 7 days.");
  });

  it("names the one contact for a client, or lists several", () => {
    const person = (title: string, subtitle: string) => ({ id: title, type: "record", title, href: "/GRE/organisations/o1", record: { kind: "person", subtitle } }) as never;
    expect(answerPeople("Acme", [person("Ada Kestrel", "CFO at Acme Ltd")]).headline).toBe("Your contact for Acme is Ada Kestrel (CFO at Acme Ltd).");
    const many = answerPeople("Acme", [person("Ada Kestrel", "CFO at Acme Ltd"), person("Ben Osei", "COO at Acme Ltd")]);
    expect(many.headline).toBe("2 people for Acme, starting with Ada Kestrel.");
    expect(many.lines.map((line) => line.text)).toEqual(["Ada Kestrel", "Ben Osei"]);
    expect(answerPeople("Acme", []).more?.href).toBe("/search?q=Acme&scope=records&kind=person");
  });

  it("says when there is no history and links to all notes and calls", () => {
    const answer = answerHistory("Acme", []);
    expect(answer.headline).toBe("I could not find any notes, calls or meetings about Acme.");
    expect(answer.more?.href).toBe("/search?q=Acme&scope=records&kind=activity");
  });

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

  it("puts matching clients and people first, and answers with them when there are no tasks", () => {
    const records = [
      { id: "organisation:o1", type: "record", title: "Indago Ltd", href: "/PAP/organisations/o1", record: { kind: "organisation", subtitle: "Finance, UK" } },
      { id: "person:p1", type: "record", title: "Ada Indago", href: "/PAP/organisations/o1", record: { kind: "person", subtitle: "CFO at Indago Ltd" } },
      { id: "issue:x", type: "issue", title: "Not a record", href: "/PAP/issues/X-1" },
    ] as unknown as Parameters<typeof answerSubject>[2];
    const withTasks = answerSubject("indago", [issue({ id: "a", title: "Draft proposal", status: "in_progress" })], records);
    expect(withTasks.lines.map((line) => line.text)).toEqual(["Indago Ltd", "Ada Indago", "Draft proposal"]);
    expect(withTasks.lines[0]).toEqual({ text: "Indago Ltd", detail: "Organisation: Finance, UK", href: "/PAP/organisations/o1" });
    const noTasks = answerSubject("indago", [], records);
    expect(noTasks.headline).toBe("I found Indago Ltd and 1 more record, but no tasks about indago yet.");
    expect(noTasks.lines[1]?.detail).toBe("Person: CFO at Indago Ltd");
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

  it("adds client notes and calls since the last visit", () => {
    const quiet = { ...digest, counts: { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0 }, agents: [] };
    const answer = answerAway(quiet, [], null, {
      days: 1,
      total: 3,
      clientCount: 2,
      byKind: [["Call", 3]],
      activity: [{ id: "a1", kindLabel: "Call", title: "Pricing call", clientName: "Heron Ltd", ownerName: null, occurredAt: "2026-10-17T09:00:00.000Z", href: "/GRE/organisations/o1" }],
    });
    expect(answer.headline).toBe("In the last 24 hours: 0 tasks finished, 0 got stuck, 0 things need you, 3 client notes and calls.");
    expect(answer.lines).toEqual([{ text: "Pricing call", detail: "Call, Heron Ltd", href: "/GRE/organisations/o1" }]);
  });

  it("says plainly when nothing happened", () => {
    const quiet = { ...digest, counts: { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0 }, agents: [] };
    expect(answerAway(quiet, [], null).headline).toBe(
      "In the last 24 hours: nothing new. Nothing finished, nothing got stuck and nothing needs you.",
    );
  });
});

describe("follow-up questions", () => {
  const now = new Date("2026-10-16T09:00:00");
  const set = {
    about: "stuck tasks",
    issues: [
      issue({ id: "a", identifier: "GRE-1", title: "Contract", status: "blocked", dueDate: "2026-10-13", assigneeAgentId: "mason" }),
      issue({ id: "b", identifier: "GRE-2", title: "Venue", status: "blocked", dueDate: "2026-10-20", priority: "high" }),
      issue({ id: "c", identifier: "GRE-3", title: "Logo", status: "done", dueDate: "2026-10-01" }),
    ],
  };
  const name = (id: string | null) => (id === "mason" ? "Mason" : null);

  it("only treats questions that point back as follow-ups", () => {
    expect(followUpRefinement("and which of those are overdue?", agents)).toEqual({ kind: "overdue" });
    expect(followUpRefinement("Which ones are urgent?", agents)).toEqual({ kind: "urgent" });
    expect(followUpRefinement("what about Mason?", agents)).toEqual({ kind: "agent", agentId: "mason", agentName: "Mason" });
    expect(followUpRefinement("What is overdue?", agents)).toBeNull();
    expect(followUpRefinement("and the weather?", agents)).toBeNull();
  });

  it("narrows the last answer and says how late", () => {
    const answer = answerFollowUp({ kind: "overdue" }, set, name, now);
    expect(answer.headline).toBe("1 of those 3 stuck tasks is overdue.");
    expect(answer.lines).toEqual([{ text: "Contract", detail: "Due 2026-10-13, 3 days late. With Mason.", href: "/issues/GRE-1" }]);
    expect(narrowTasks({ kind: "urgent" }, set.issues, now).map((task) => task.id)).toEqual(["b"]);
  });

  it("says so when nothing matches, and when there are no due dates", () => {
    const undated = { about: "stuck tasks", issues: [issue({ id: "x" }), issue({ id: "y" })] };
    expect(answerFollowUp({ kind: "overdue" }, undated, name, now).headline).toBe(
      "None of those 2 stuck tasks are overdue. None of them has a due date yet.",
    );
    expect(answerFollowUp({ kind: "done" }, { about: "stuck tasks", issues: [issue({ id: "x" })] }, name, now).headline).toBe(
      "That task is not done.",
    );
  });
});

describe("asking about a page", () => {
  const context = pipelineItemAskContext({ title: "Acme Ltd", pipelineName: "Clients", stageName: "Proposal", statusLabel: "Active", isClient: true });

  it("describes the client and offers questions about it", () => {
    expect(context.summary).toBe('The client "Acme Ltd" in the Clients pipeline. Stage: Proposal. Status: Active.');
    expect(context.suggestions).toContain("What is Acme Ltd waiting on?");
  });

  it("points a vague question at the page's subject", () => {
    expect(intentWithContext({ kind: "overview" }, context)).toEqual({ kind: "subject", subject: "Acme Ltd" });
    expect(intentWithContext({ kind: "stuck", subject: null }, context)).toEqual({ kind: "stuck", subject: "Acme Ltd" });
    expect(intentWithContext({ kind: "decide" }, context)).toEqual({ kind: "decide" });
    expect(intentWithContext({ kind: "overview" }, null)).toEqual({ kind: "overview" });
    expect(intentWithContext({ kind: "history", subject: null }, context)).toEqual({ kind: "history", subject: "Acme Ltd" });
    expect(intentWithContext({ kind: "history", subject: "Indago" }, context)).toEqual({ kind: "history", subject: "Indago" });
  });

  it("sends Everest the page and the question it follows", () => {
    expect(liveQuestionText("and which are late?", { followsUp: "What is stuck?" })).toBe(
      'and which are late? (Following up on: "What is stuck?")',
    );
    expect(liveQuestionText("What next?", { context })).toBe(`What next?\n\nAsked from Acme Ltd:\n${context.summary}`);
  });
});

describe("organisationAskContext", () => {
  it("sums up the organisation, its people and its deals", () => {
    const context = organisationAskContext({
      name: "Acme Ltd",
      industry: "Mining",
      country: "Ghana",
      statusLabel: "Client",
      contacts: [{ name: "Kofi Mensah", role: "CFO" }, { name: "Ama", role: null }],
      deals: [{ title: "Drill rig", pipelineName: "Sales", stageName: "Won" }],
    });
    expect(context.label).toBe("Acme Ltd");
    expect(context.subject).toBe("Acme Ltd");
    expect(context.summary).toBe('The organisation "Acme Ltd" (Mining, Ghana). Status: Client.\nPeople: Kofi Mensah (CFO); Ama.\nDeals: Drill rig: Won in Sales.');
    expect(context.suggestions?.[0]).toBe("What is happening with Acme Ltd?");
  });

  it("adds the latest imported notes and calls, without stage changes", () => {
    const context = organisationAskContext({
      name: "Acme Ltd",
      industry: null,
      country: null,
      statusLabel: "Client",
      contacts: [],
      deals: [],
      history: [
        { kind: "stage_change", activityType: null, subject: "Moved to Won", body: null, occurredAt: "2026-10-14T09:00:00Z" },
        { kind: "activity", activityType: "call", subject: "Pricing call", body: "<p>Agreed the <b>gold</b> tier</p>", occurredAt: "2026-10-12T10:00:00Z" },
        { kind: "note", activityType: null, subject: null, body: "Budget signed off", occurredAt: null },
      ],
    });
    expect(context.summary).toContain("Latest history: 2026-10-12, call: Pricing call (Agreed the gold tier); note: Budget signed off.");
    expect(context.summary).not.toContain("Moved to Won");
    expect(context.suggestions).toContain("What did we last discuss with Acme Ltd?");
  });
});
