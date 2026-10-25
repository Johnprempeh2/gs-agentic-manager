// Browser QA access for an agent (GRE-2387). One click by a board owner gives
// an agent a member log-in of its own, `qa-<agent>@<company>.local`, with a
// Viewer or Operator role and an expiry. Nobody types or sees a password.
//
// A user with any row in agent_qa_logins is a QA account. It is let in only
// while one of its rows is active and not past its expiry (the actor
// middleware checks this on every request, so a missed sweep never extends
// access). At expiry, or on "Revoke now", the membership is suspended, its
// rights, sessions and board keys are removed, and the event is written to the
// activity log.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  agentQaLogins,
  agents,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  principalPermissionGrants,
  type Db,
} from "@greatstone/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { grantsForHumanRole } from "./company-member-roles.js";

export const AGENT_QA_LOGIN_ROLES = ["viewer", "operator"] as const;
export type AgentQaLoginRole = (typeof AGENT_QA_LOGIN_ROLES)[number];
export const AGENT_QA_LOGIN_DEFAULT_DAYS = 7;
export const AGENT_QA_LOGIN_MAX_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AgentQaLoginView {
  id: string;
  agentId: string;
  userId: string;
  email: string;
  role: AgentQaLoginRole;
  status: "active" | "revoked" | "expired";
  expiresAt: string;
  grantedByUserId: string;
  createdAt: string;
  endedAt: string | null;
}

/** What the actor middleware needs to know about a signed-in user. */
export type QaLoginStanding =
  | { kind: "not_qa" }
  | { kind: "active"; loginId: string; companyId: string; agentId: string; expiresAt: Date }
  | { kind: "inactive" };

function slugPart(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/** `qa-<agent>@<company>.local`, from the agent's name and the company's issue prefix. */
export function qaLoginEmail(agentName: string, companyPrefix: string): string {
  return `qa-${slugPart(agentName, "agent")}@${slugPart(companyPrefix, "company")}.local`;
}

export function qaLoginDisplayName(agentName: string): string {
  return `QA for ${agentName}`;
}

export function isAgentQaLoginRole(value: unknown): value is AgentQaLoginRole {
  return AGENT_QA_LOGIN_ROLES.includes(value as AgentQaLoginRole);
}

function toView(row: typeof agentQaLogins.$inferSelect, email: string): AgentQaLoginView {
  return {
    id: row.id,
    agentId: row.agentId,
    userId: row.userId,
    email,
    role: row.role as AgentQaLoginRole,
    status: row.status as AgentQaLoginView["status"],
    expiresAt: row.expiresAt.toISOString(),
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

/** Removes every way the QA log-in can act: membership, rights, sessions, board keys. */
async function shutLogin(tx: Tx, input: { companyId: string; userId: string; now: Date }) {
  await tx
    .update(companyMemberships)
    .set({ status: "suspended", updatedAt: input.now })
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.userId),
      ),
    );
  await tx
    .delete(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, "user"),
        eq(principalPermissionGrants.principalId, input.userId),
      ),
    );
  await tx.delete(authSessions).where(eq(authSessions.userId, input.userId));
  await tx
    .update(boardApiKeys)
    .set({ revokedAt: input.now })
    .where(and(eq(boardApiKeys.userId, input.userId), sql`${boardApiKeys.revokedAt} is null`));
}

export function agentQaLoginService(db: Db) {
  async function emailFor(userId: string): Promise<string> {
    const row = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).then((r) => r[0]);
    return row?.email ?? "";
  }

  /** The agent's current grant, or null. */
  async function getActive(companyId: string, agentId: string): Promise<AgentQaLoginView | null> {
    const row = await db
      .select({ login: agentQaLogins, email: authUsers.email })
      .from(agentQaLogins)
      .innerJoin(authUsers, eq(authUsers.id, agentQaLogins.userId))
      .where(and(eq(agentQaLogins.companyId, companyId), eq(agentQaLogins.agentId, agentId), eq(agentQaLogins.status, "active")))
      .then((rows) => rows[0] ?? null);
    return row ? toView(row.login, row.email) : null;
  }

  /** Active grants in the company, by user id, for the Members badge. */
  async function listActiveForCompany(companyId: string) {
    return db
      .select({
        userId: agentQaLogins.userId,
        agentId: agentQaLogins.agentId,
        agentName: agents.name,
        role: agentQaLogins.role,
        expiresAt: agentQaLogins.expiresAt,
      })
      .from(agentQaLogins)
      .innerJoin(agents, eq(agents.id, agentQaLogins.agentId))
      .where(and(eq(agentQaLogins.companyId, companyId), eq(agentQaLogins.status, "active")));
  }

  /** Every user id that has ever been a QA account in the company. */
  async function listQaUserIds(companyId: string): Promise<Set<string>> {
    const rows = await db
      .selectDistinct({ userId: agentQaLogins.userId })
      .from(agentQaLogins)
      .where(eq(agentQaLogins.companyId, companyId));
    return new Set(rows.map((r) => r.userId));
  }

  async function standingForUser(userId: string, now = new Date()): Promise<QaLoginStanding> {
    const rows = await db
      .select({
        id: agentQaLogins.id,
        companyId: agentQaLogins.companyId,
        agentId: agentQaLogins.agentId,
        status: agentQaLogins.status,
        expiresAt: agentQaLogins.expiresAt,
      })
      .from(agentQaLogins)
      .where(eq(agentQaLogins.userId, userId));
    if (rows.length === 0) return { kind: "not_qa" };
    const live = rows.find((r) => r.status === "active" && r.expiresAt.getTime() > now.getTime());
    if (!live) return { kind: "inactive" };
    return { kind: "active", loginId: live.id, companyId: live.companyId, agentId: live.agentId, expiresAt: live.expiresAt };
  }

  async function grant(input: {
    companyId: string;
    agentId: string;
    role: unknown;
    expiresInDays?: unknown;
    grantedByUserId: string;
    now?: Date;
  }): Promise<AgentQaLoginView> {
    if (!isAgentQaLoginRole(input.role)) {
      throw unprocessable("A QA log-in can only be Viewer or Operator.");
    }
    const role = input.role;
    const days = input.expiresInDays === undefined || input.expiresInDays === null ? AGENT_QA_LOGIN_DEFAULT_DAYS : Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > AGENT_QA_LOGIN_MAX_DAYS) {
      throw unprocessable(`Expiry must be a whole number of days from 1 to ${AGENT_QA_LOGIN_MAX_DAYS}.`);
    }
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + days * DAY_MS);

    const created = await db.transaction(async (tx) => {
      const agent = await tx
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      if (agent.status === "terminated") throw conflict("This agent is terminated.");
      const company = await tx
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .then((rows) => rows[0]!);

      const active = await tx
        .select({ id: agentQaLogins.id })
        .from(agentQaLogins)
        .where(and(eq(agentQaLogins.companyId, input.companyId), eq(agentQaLogins.agentId, agent.id), eq(agentQaLogins.status, "active")))
        .then((rows) => rows[0] ?? null);
      if (active) throw conflict("This agent already has browser QA access. Revoke it first.");

      // Reuse the agent's earlier QA log-in, so its history stays on one user.
      const earlier = await tx
        .select({ userId: agentQaLogins.userId })
        .from(agentQaLogins)
        .where(and(eq(agentQaLogins.companyId, input.companyId), eq(agentQaLogins.agentId, agent.id)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const displayName = qaLoginDisplayName(agent.name);
      let userId: string;
      let email: string;
      if (earlier) {
        userId = earlier.userId;
        await tx.update(authUsers).set({ name: displayName, updatedAt: now }).where(eq(authUsers.id, userId));
        email = (await tx.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).then((r) => r[0]?.email)) ?? "";
      } else {
        userId = randomUUID();
        email = qaLoginEmail(agent.name, company.issuePrefix);
        const taken = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(sql`lower(${authUsers.email}) = ${email}`)
          .then((rows) => rows[0] ?? null);
        // Never take over someone else's log-in: add the agent id to make it unique.
        if (taken) email = email.replace("@", `-${agent.id.slice(0, 8)}@`);
        await tx.insert(authUsers).values({ id: userId, name: displayName, email, emailVerified: false, createdAt: now, updatedAt: now });
      }

      const membership = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (membership) {
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: role, updatedAt: now })
          .where(eq(companyMemberships.id, membership.id));
      } else {
        await tx.insert(companyMemberships).values({
          companyId: input.companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: role,
        });
      }
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, input.companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
          ),
        );
      const keys = grantsForHumanRole(role);
      if (keys.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          keys.map((grant) => ({
            companyId: input.companyId,
            principalType: "user",
            principalId: userId,
            permissionKey: grant.permissionKey,
            scope: grant.scope,
            grantedByUserId: input.grantedByUserId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }

      const [row] = await tx
        .insert(agentQaLogins)
        .values({
          companyId: input.companyId,
          agentId: agent.id,
          userId,
          role,
          status: "active",
          expiresAt,
          grantedByUserId: input.grantedByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { view: toView(row!, email), agentName: agent.name };
    });

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.grantedByUserId,
      action: "agent_qa_login.granted",
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      details: {
        qaLoginId: created.view.id,
        qaUserId: created.view.userId,
        email: created.view.email,
        agentName: created.agentName,
        role,
        expiresAt: created.view.expiresAt,
      },
    });
    return created.view;
  }

  async function end(
    row: typeof agentQaLogins.$inferSelect,
    input: { reason: "revoked" | "expired"; byUserId: string | null; now: Date },
  ): Promise<boolean> {
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(agentQaLogins)
        .set({ status: input.reason, endedAt: input.now, endedByUserId: input.byUserId, updatedAt: input.now })
        .where(and(eq(agentQaLogins.id, row.id), eq(agentQaLogins.status, "active")))
        .returning({ id: agentQaLogins.id });
      if (updated.length === 0) return false;
      await shutLogin(tx, { companyId: row.companyId, userId: row.userId, now: input.now });
      return true;
    });
    if (!changed) return false;
    await logActivity(db, {
      companyId: row.companyId,
      actorType: input.byUserId ? "user" : "system",
      actorId: input.byUserId ?? "agent_qa_login_expiry",
      action: input.reason === "revoked" ? "agent_qa_login.revoked" : "agent_qa_login.expired",
      entityType: "agent",
      entityId: row.agentId,
      agentId: row.agentId,
      details: {
        qaLoginId: row.id,
        qaUserId: row.userId,
        email: await emailFor(row.userId),
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
      },
    });
    return true;
  }

  async function revoke(input: { companyId: string; agentId: string; byUserId: string; now?: Date }): Promise<AgentQaLoginView> {
    const row = await db
      .select()
      .from(agentQaLogins)
      .where(and(eq(agentQaLogins.companyId, input.companyId), eq(agentQaLogins.agentId, input.agentId), eq(agentQaLogins.status, "active")))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("This agent has no browser QA access.");
    const now = input.now ?? new Date();
    await end(row, { reason: "revoked", byUserId: input.byUserId, now });
    const after = await db.select().from(agentQaLogins).where(eq(agentQaLogins.id, row.id)).then((rows) => rows[0]!);
    return toView(after, await emailFor(row.userId));
  }

  /** Ends every grant past its expiry. Safe to run again; returns how many it ended. */
  async function reapExpired(now = new Date()): Promise<number> {
    const due = await db
      .select()
      .from(agentQaLogins)
      .where(and(eq(agentQaLogins.status, "active"), lte(agentQaLogins.expiresAt, now)));
    let ended = 0;
    for (const row of due) {
      if (await end(row, { reason: "expired", byUserId: null, now })) ended += 1;
    }
    return ended;
  }

  /** True when any of the user ids is a QA account in the company. */
  async function anyQaUser(companyId: string, userIds: string[]): Promise<boolean> {
    if (userIds.length === 0) return false;
    const row = await db
      .select({ id: agentQaLogins.id })
      .from(agentQaLogins)
      .where(and(eq(agentQaLogins.companyId, companyId), inArray(agentQaLogins.userId, userIds)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  /** True only while this exact grant is active, not past expiry, and its membership is active. */
  async function isGrantLive(input: {
    loginId: string;
    userId: string;
    companyId: string;
    agentId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const row = await db
      .select({ expiresAt: agentQaLogins.expiresAt, membershipStatus: companyMemberships.status })
      .from(agentQaLogins)
      .innerJoin(
        companyMemberships,
        and(
          eq(companyMemberships.companyId, agentQaLogins.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, agentQaLogins.userId),
        ),
      )
      .where(
        and(
          eq(agentQaLogins.id, input.loginId),
          eq(agentQaLogins.userId, input.userId),
          eq(agentQaLogins.companyId, input.companyId),
          eq(agentQaLogins.agentId, input.agentId),
          eq(agentQaLogins.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row && row.membershipStatus === "active" && row.expiresAt.getTime() > now.getTime());
  }

  /** Audit: an agent asked for a one-time browser login link. The link itself is never logged. */
  async function recordBrowserLoginIssued(input: {
    login: AgentQaLoginView;
    companyId: string;
    runId: string | null;
    nonce: string;
    linkExpiresAt: Date;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.login.agentId,
      action: "agent_qa_login.browser_login_issued",
      entityType: "agent",
      entityId: input.login.agentId,
      agentId: input.login.agentId,
      runId: input.runId,
      details: {
        qaLoginId: input.login.id,
        qaUserId: input.login.userId,
        email: input.login.email,
        nonce: input.nonce,
        linkExpiresAt: input.linkExpiresAt.toISOString(),
      },
    });
  }

  return {
    grant,
    revoke,
    reapExpired,
    getActive,
    listActiveForCompany,
    listQaUserIds,
    standingForUser,
    anyQaUser,
    isGrantLive,
    recordBrowserLoginIssued,
  };
}
