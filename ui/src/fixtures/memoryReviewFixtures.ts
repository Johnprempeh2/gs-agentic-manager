import type { MemoryRecord, MemoryReviewQueue, MemoryReviewQueueItem } from "@greatstone/shared";

// Synthetic steward review queue (GRE-1080). Names and text are examples only.

const SCOPE_OPS = { id: "00000000-0000-4000-8000-0000000000a1", name: "Operations", kind: "organization" as const };
const SCOPE_SALES = { id: "00000000-0000-4000-8000-0000000000a2", name: "Sales", kind: "organization" as const };

export function reviewRecord(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    companyId: "co-kestrel",
    scopeId: SCOPE_OPS.id,
    scopeKind: "organization",
    kind: "source_statement",
    status: "unreviewed",
    entryType: "proposal",
    decisionClass: "operational",
    sensitivity: "internal",
    title: null,
    content: null,
    entities: [],
    topics: [],
    contributorAgentId: null,
    contributorUserId: null,
    runId: null,
    sourceKind: null,
    sourceId: null,
    effectiveFrom: null,
    effectiveTo: null,
    supersedesId: null,
    supersededById: null,
    supersededAt: null,
    reviewedAt: null,
    version: 1,
    retainMode: "extract",
    syncState: "synced",
    createdAt: "2026-10-08T09:00:00.000Z",
    updatedAt: "2026-10-08T09:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

const ALLOWED = { confirm: true, edit_and_confirm: true, reject: true, merge: true };

export const invoiceProposal: MemoryReviewQueueItem = {
  proposal: reviewRecord({
    id: "00000000-0000-4000-8000-000000000101",
    title: "Invoice day",
    content: "Client invoices go out on the first working day.",
    contributorUserId: "user-ama",
    version: 2,
    supersedesId: "00000000-0000-4000-8000-000000000100",
  }),
  proposer: { type: "user", id: "user-ama", name: "Ama", app: "ChatGPT" },
  editedBy: null,
  current: reviewRecord({
    id: "00000000-0000-4000-8000-000000000100",
    status: "approved",
    entryType: "observation",
    title: "Invoice day",
    content: "Client invoices go out on the last working day of the month.",
    createdAt: "2026-08-01T09:00:00.000Z",
  }),
  scope: SCOPE_OPS,
  ageDays: 9,
  ageFlag: "overdue",
  conflictIds: [],
  allowed: ALLOWED,
  blockedReason: null,
};

export const ownProposal: MemoryReviewQueueItem = {
  proposal: reviewRecord({
    id: "00000000-0000-4000-8000-000000000201",
    title: "Weekly sales call",
    content: "The sales call is on Tuesdays at 10:00.",
    contributorUserId: "user-john",
    scopeId: SCOPE_SALES.id,
  }),
  proposer: { type: "user", id: "user-john", name: "John", app: "Claude Code" },
  editedBy: null,
  current: null,
  scope: SCOPE_SALES,
  ageDays: 1,
  ageFlag: "fresh",
  conflictIds: ["00000000-0000-4000-8000-0000000c0001"],
  allowed: { confirm: false, edit_and_confirm: true, reject: true, merge: true },
  blockedReason: "You proposed this card. Another steward must confirm it.",
};

export const expiredProposal: MemoryReviewQueueItem = {
  proposal: reviewRecord({
    id: "00000000-0000-4000-8000-000000000301",
    title: "Old supplier note",
    content: "Paper supplier closes in August.",
    contributorAgentId: "agent-everest",
    createdAt: "2026-08-20T09:00:00.000Z",
  }),
  proposer: { type: "agent", id: "agent-everest", name: "Everest", app: null },
  editedBy: null,
  current: null,
  scope: SCOPE_OPS,
  ageDays: 50,
  ageFlag: "expired",
  conflictIds: [],
  allowed: ALLOWED,
  blockedReason: null,
};

export const reviewQueue: MemoryReviewQueue = {
  // Deliberately out of order: the screen must still rank expired last.
  items: [expiredProposal, invoiceProposal, ownProposal],
  facets: {
    scopes: [
      { id: SCOPE_OPS.id, name: SCOPE_OPS.name, count: 2 },
      { id: SCOPE_SALES.id, name: SCOPE_SALES.name, count: 1 },
    ],
    people: [
      { type: "user", id: "user-ama", name: "Ama", count: 1 },
      { type: "agent", id: "agent-everest", name: "Everest", count: 1 },
      { type: "user", id: "user-john", name: "John", count: 1 },
    ],
    apps: [
      { app: "ChatGPT", count: 1 },
      { app: "Claude Code", count: 1 },
    ],
  },
};
