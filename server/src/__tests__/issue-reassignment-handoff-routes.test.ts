import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF_HANDOFF_GRACE_MS } from "../services/reassignment-handover.js";

// GRE-36: reassignment hands work over instead of dropping it.

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PAUSED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const agentStatusById: Record<string, string> = {
  [AGENT_ACTOR_ID]: "idle",
  [PAUSED_AGENT_ID]: "paused",
  [IDLE_AGENT_ID]: "idle",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(async () => ({ adoptedFromRunId: null })),
  findOpenAncestorCreatedByAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

type Actor = Record<string, unknown>;

function boardActor(): Actor {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ACTOR_ID,
    companyId: "company-1",
    source: "agent_key",
    runId: AGENT_RUN_ID,
  };
}

// Minimal chainable/thenable db stub: any query resolves to an empty row set.
// Run containment is mocked because this suite targets assignee invokability.
function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  return { select: () => query };
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ACTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Invokability test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

const NEW_AGENT_ID = IDLE_AGENT_ID;
const OTHER_RUN_ID = "55555555-5555-4555-8555-555555555555";

function runningRun(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_RUN_ID,
    companyId: "company-1",
    agentId: AGENT_ACTOR_ID,
    status: "running",
    runtimeMode: "legacy",
    processStartedAt: new Date("2026-09-27T20:00:00Z"),
    contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ...overrides,
  };
}

async function reassign(actor: Actor, run: Record<string, unknown>) {
  const existing = makeIssue({ status: "in_progress", executionRunId: run.id });
  mockIssueService.getById.mockResolvedValue(existing);
  mockIssueService.update.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: NEW_AGENT_ID }));
  mockHeartbeatService.getRun.mockResolvedValue(run as never);
  mockHeartbeatService.cancelRun.mockImplementation((async (id: string) => ({ ...run, id, status: "cancelled" })) as never);
  const res = await request(createApp(actor))
    .patch(`/api/issues/${existing.id}`)
    .send({ assigneeAgentId: NEW_AGENT_ID });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalled());
  const [agentId, wake] = mockHeartbeatService.wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }];
  expect(agentId).toBe(NEW_AGENT_ID);
  return wake.contextSnapshot;
}

describe("reassignment while a run is live (GRE-36)", () => {
  let timers: Array<{ callback: () => void; ms: number | undefined }>;
  const realSetTimeout = globalThis.setTimeout;
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockHeartbeatService.wakeup.mockClear();
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.getRun.mockReset();
    timers = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === SELF_HANDOFF_GRACE_MS) {
        timers.push({ callback, ms });
        return { unref() {} } as never;
      }
      return realSetTimeout(callback, ms, ...rest);
    }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not cancel the run that hands its own task over, and hands its work to the new assignee", async () => {
    const context = await reassign(agentActor(), runningRun());

    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(context.handoffFromRunId).toBe(AGENT_RUN_ID);
    expect(context.interruptedRunId).toBeUndefined();
    expect(timers).toHaveLength(1);
  });

  it("stops a self-handoff run that is still going when the grace period ends", async () => {
    await reassign(agentActor(), runningRun());
    timers[0]!.callback();
    await vi.waitFor(() => expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      AGENT_RUN_ID,
      expect.any(String),
      expect.objectContaining({
        errorCode: "issue_reassigned",
        resultJson: expect.objectContaining({ handoffGraceExpired: true }),
      }),
    ));
  });

  it("leaves a self-handoff run alone if it finished inside the grace period", async () => {
    await reassign(agentActor(), runningRun());
    mockHeartbeatService.getRun.mockResolvedValue(runningRun({ status: "succeeded" }) as never);
    timers[0]!.callback();
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("withdraws a run reassigned before its provider started, with nothing to hand over", async () => {
    // Live case 258b98d3: woken by a comment, reassigned 5s later, no process yet.
    const context = await reassign(boardActor(), runningRun({ id: OTHER_RUN_ID, processStartedAt: null }));

    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      OTHER_RUN_ID,
      expect.stringContaining("before its provider started"),
      expect.objectContaining({
        resultJson: expect.objectContaining({ reassignmentStage: "before_provider_start" }),
      }),
    );
    expect(context.interruptedRunId).toBeUndefined();
    expect(context.handoffFromRunId).toBeUndefined();
    expect(timers).toHaveLength(0);
  });

  it("stops a working run at once when someone else reassigns it, and hands it over", async () => {
    const context = await reassign(boardActor(), runningRun({ id: OTHER_RUN_ID }));

    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      OTHER_RUN_ID,
      "Cancelled before issue reassignment",
      expect.objectContaining({ errorCode: "issue_reassigned" }),
    );
    expect(context.interruptedRunId).toBe(OTHER_RUN_ID);
    expect(timers).toHaveLength(0);
  });
});
