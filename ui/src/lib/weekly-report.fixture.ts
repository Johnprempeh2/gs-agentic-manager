import type { WeeklyReport } from "@greatstone/shared";

/** A full week, for tests and stories. */
export const WEEKLY_REPORT_FIXTURE: WeeklyReport = {
  companyId: "c1",
  companyName: "Greatstone",
  generatedAt: "2026-10-19T07:00:00.000Z",
  since: "2026-10-12T07:00:00.000Z",
  finished: {
    count: 3,
    agents: [
      { agentId: "a1", name: "Ridge", finished: 2, items: [{ id: "t1", identifier: "GRE-1", title: "Booking page" }, { id: "t2", identifier: "GRE-2", title: "Client deck" }] },
      { agentId: "a2", name: "Nova", finished: 1, items: [{ id: "t3", identifier: "GRE-3", title: "Venue shortlist" }] },
    ],
  },
  stuck: {
    count: 2,
    items: [
      { id: "t4", identifier: "GRE-4", title: "Pipedrive import", agentName: "Ridge", stuckSince: "2026-10-10T07:00:00.000Z" },
      { id: "t5", identifier: "GRE-5", title: "Logo files", agentName: null, stuckSince: "2026-10-19T05:00:00.000Z" },
    ],
  },
  pipeline: {
    added: 1,
    moved: 2,
    won: 1,
    lost: 0,
    moves: [
      { caseId: "k1", title: "Acme", pipelineName: "Client journey", fromStage: "Proposal", toStage: "Won", at: "2026-10-18T10:00:00.000Z" },
      { caseId: "k2", title: "Beta Ltd", pipelineName: "Client journey", fromStage: "Lead", toStage: "Proposal", at: "2026-10-17T10:00:00.000Z" },
    ],
  },
  needsYou: { count: 6, items: [{ id: "t6", identifier: "GRE-6", title: "Approve the brief" }] },
  costs: { totalCents: 1300, agents: [{ agentId: "a2", name: "Nova", cents: 900 }, { agentId: "a1", name: "Ridge", cents: 400 }] },
};
