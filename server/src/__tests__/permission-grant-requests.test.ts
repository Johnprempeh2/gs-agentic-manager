import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@greatstone/db";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { attentionRoutes } from "../routes/attention.js";
import { decisionsFeedRoutes } from "../routes/decisions-feed.js";
import {
  parseMissingPermissionKey,
  permissionGrantRequestService,
} from "../services/permission-grant-requests.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type SeededCompany,
} from "./helpers/route-test-harness.js";

const wakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup }) };
});

it("reads the key from a single-key refusal only", () => {
  expect(parseMissingPermissionKey("Missing permission: inbox:manage.")).toBe("inbox:manage");
  expect(parseMissingPermissionKey("Missing permission: tasks:assign")).toBe("tasks:assign");
  expect(parseMissingPermissionKey("Missing permission: agents:create or agents:suggest-changes.")).toBeNull();
  expect(parseMissingPermissionKey("Missing permission: not:a-key.")).toBeNull();
  expect(parseMissingPermissionKey("Board access required")).toBeNull();
});

describeEmbeddedPostgres("missing-permission refusal opens a Grant / Deny item (GRE-601)", () => {
  const ctx = useEmbeddedPostgres("gsam-permission-grant-requests-");

  beforeEach(() => {
    wakeup.mockReset();
    wakeup.mockResolvedValue({ id: randomUUID() });
  });

  async function seedBlockedAgent(company: SeededCompany) {
    const db = ctx.db;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: company.companyId,
      name: "Cairn",
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      identifier: `GRE-${Math.floor(Math.random() * 100000)}`,
      title: "Triage the inbox",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    return { agentId, issueId, runId, identifier: issue.identifier! };
  }

  async function openItems(companyId: string, agentId: string) {
    return ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.requestedByAgentId, agentId)));
  }

  async function grantRows(companyId: string, agentId: string) {
    return ctx.db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, "inbox:manage"),
      ));
  }

  /** An app whose only route refuses the calling agent, behind the real error handler. */
  function refusingApp(agent: { agentId: string; companyId: string; runId: string }) {
    const app = express();
    app.locals.paperclipDb = ctx.db;
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", ...agent };
      next();
    });
    app.post("/api/refuse", () => {
      throw forbidden("Missing permission: inbox:manage.");
    });
    app.use(errorHandler);
    return app;
  }

  async function waitFor<T>(read: () => Promise<T[]>, count: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await read();
      if (rows.length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return read();
  }

  it("a refusal to an agent opens one item, and a repeat refusal does not duplicate it", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Refusal");
    const blocked = await seedBlockedAgent(company);
    const app = refusingApp({ agentId: blocked.agentId, companyId: company.companyId, runId: blocked.runId });

    const first = await request(app).post("/api/refuse");
    expect(first.status).toBe(403);
    const rows = await waitFor(() => openItems(company.companyId, blocked.agentId), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "permission_grant",
      status: "pending",
      payload: expect.objectContaining({
        agentId: blocked.agentId,
        permissionKey: "inbox:manage",
        issueId: blocked.issueId,
        title: `Cairn needs inbox:manage for ${blocked.identifier}`,
      }),
    });
    const links = await ctx.db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, rows[0]!.id));
    expect(links.map((link) => link.issueId)).toEqual([blocked.issueId]);

    await request(app).post("/api/refuse").expect(403);
    const again = await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    });
    expect(again?.created).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await openItems(company.companyId, blocked.agentId)).toHaveLength(1);
  });

  it("the attention list shows the item with Grant and Deny only to its own company", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Attention");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const blocked = await seedBlockedAgent(company);
    const { approval } = (await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    }))!;

    const own = await request(routeApp(ctx.db, company.actor, attentionRoutes as never))
      .get(`/api/companies/${company.companyId}/attention?all=true`)
      .expect(200);
    const item = own.body.items.find((entry: any) => entry.subject.id === approval.id);
    expect(item.subject.title).toBe(`Cairn needs inbox:manage for ${blocked.identifier}`);
    expect(item.decisionVerbs.map((verb: any) => verb.label)).toEqual(["Deny", "Grant"]);

    const feed = await request(routeApp(ctx.db, company.actor, decisionsFeedRoutes as never))
      .get(`/api/companies/${company.companyId}/decisions-feed`)
      .expect(200);
    const card = feed.body.cards.find((entry: any) => entry.items.some((row: any) => row.subject.id === approval.id));
    expect(card.reason).toBe(`Cairn needs inbox:manage for ${blocked.identifier}`);
    expect(card.nextStep).toBe("Cairn stays blocked until you grant or deny the permission.");
    const labels = card.actions.map((action: any) => action.label);
    expect(labels).toEqual(expect.arrayContaining(["Grant", "Deny"]));
    expect(labels).not.toContain("Approve");

    const otherApp = routeApp(ctx.db, other.actor, attentionRoutes as never, approvalRoutes as never);
    await request(otherApp).get(`/api/companies/${company.companyId}/attention?all=true`).expect(403);
    const otherFeed = await request(otherApp).get(`/api/companies/${other.companyId}/attention?all=true`).expect(200);
    expect(otherFeed.body.items.some((entry: any) => entry.subject.id === approval.id)).toBe(false);
    await request(otherApp).get(`/api/approvals/${approval.id}`).expect(404);
    await request(otherApp).post(`/api/approvals/${approval.id}/approve`).send({}).expect(404);
    await request(otherApp).post(`/api/approvals/${approval.id}/reject`).send({}).expect(404);
    expect(await grantRows(company.companyId, blocked.agentId)).toHaveLength(0);
  });

  it("Grant writes the grant and wakes the blocked task", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Grant");
    const blocked = await seedBlockedAgent(company);
    const { approval } = (await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    }))!;

    const res = await request(routeApp(ctx.db, company.actor, approvalRoutes as never))
      .post(`/api/approvals/${approval.id}/approve`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const grants = await grantRows(company.companyId, blocked.agentId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ principalType: "agent", grantedByUserId: company.userId });
    expect(wakeup).toHaveBeenCalledWith(
      blocked.agentId,
      expect.objectContaining({
        reason: "approval_approved",
        payload: expect.objectContaining({ approvalId: approval.id, issueId: blocked.issueId }),
      }),
    );
  });

  it("Deny closes the item and comments on the blocked task", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Deny");
    const blocked = await seedBlockedAgent(company);
    const { approval } = (await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    }))!;

    const res = await request(routeApp(ctx.db, company.actor, approvalRoutes as never))
      .post(`/api/approvals/${approval.id}/reject`)
      .send({ decisionNote: "Use Everest for inbox work." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");

    const comments = await ctx.db.select().from(issueComments).where(eq(issueComments.issueId, blocked.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("The board refused the grant `inbox:manage`");
    expect(comments[0]!.body).toContain("Use Everest for inbox work.");
    expect(await grantRows(company.companyId, blocked.agentId)).toHaveLength(0);

    // The next refusal opens a fresh item, since the old one is closed.
    const next = await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    });
    expect(next?.created).toBe(true);
  });

  it("an agent key calling Grant or Deny gets 403 and writes nothing", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "AgentKey");
    const blocked = await seedBlockedAgent(company);
    const { approval } = (await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: company.companyId,
      agentId: blocked.agentId,
      permissionKey: "inbox:manage",
      runId: blocked.runId,
    }))!;
    const agentActor = {
      type: "agent",
      source: "agent_key",
      agentId: blocked.agentId,
      companyId: company.companyId,
    } as never;
    const app = routeApp(ctx.db, agentActor, approvalRoutes as never);

    await request(app).post(`/api/approvals/${approval.id}/approve`).send({}).expect(403);
    await request(app).post(`/api/approvals/${approval.id}/reject`).send({}).expect(403);
    await request(app)
      .post(`/api/companies/${company.companyId}/approvals`)
      .send({ type: "permission_grant", payload: { agentId: blocked.agentId, permissionKey: "tools:admin" } })
      .expect(400);
    expect(await grantRows(company.companyId, blocked.agentId)).toHaveLength(0);
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row!.status).toBe("pending");
  });
});
