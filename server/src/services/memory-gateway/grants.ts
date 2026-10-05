import { and, eq, like, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, companyMemberships, principalPermissionGrants } from "@greatstone/db";
import { setMemoryGrantsSchema, type MemoryGrantablePermission, type SetMemoryGrants } from "@greatstone/shared";
import { badRequest, forbidden, notFound } from "../../errors.js";
import type { MemoryCaller, MemoryGatewayService } from "./service.js";

export type MemoryGrant = {
  principalType: "agent" | "user";
  principalId: string;
  permissions: string[];
  grantedByUserId: string | null;
  updatedAt: Date;
};

// Memory rights (G3, GRE-933). Only John (a person who owns or administers the
// company) sets them, and only here: every other grant path leaves `memory:*`
// rows alone. A grant made here always has a null scope, so it covers the
// organization and project scopes and never a client or restricted scope.
export function memoryGrantService(db: Db, gateway: MemoryGatewayService) {
  const { logOperation } = gateway.internals;

  async function assertOwner(caller: MemoryCaller, operation: string, detail: Record<string, unknown>) {
    if (caller.actorType === "user" && caller.isBoardAdmin) return;
    await logOperation(caller, operation, "denied", { detail: { reason: "not_owner", ...detail } });
    throw forbidden("Only a company owner or admin can set memory rights");
  }

  async function list(caller: MemoryCaller): Promise<MemoryGrant[]> {
    await assertOwner(caller, "grants_list", {});
    const rows = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, caller.companyId),
          like(principalPermissionGrants.permissionKey, "memory:%"),
        ),
      )
      .orderBy(principalPermissionGrants.principalType, principalPermissionGrants.principalId, principalPermissionGrants.permissionKey);
    const byPrincipal = new Map<string, MemoryGrant>();
    for (const row of rows) {
      const key = `${row.principalType}:${row.principalId}`;
      const grant = byPrincipal.get(key) ?? {
        principalType: row.principalType as MemoryGrant["principalType"],
        principalId: row.principalId,
        permissions: [],
        grantedByUserId: row.grantedByUserId,
        updatedAt: row.updatedAt,
      };
      grant.permissions.push(row.permissionKey);
      if (row.updatedAt > grant.updatedAt) grant.updatedAt = row.updatedAt;
      byPrincipal.set(key, grant);
    }
    return [...byPrincipal.values()];
  }

  async function principalExists(companyId: string, input: Pick<SetMemoryGrants, "principalType" | "principalId">) {
    if (input.principalType === "agent") {
      if (!/^[0-9a-f-]{36}$/i.test(input.principalId)) return false;
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.principalId), eq(agents.companyId, companyId), ne(agents.status, "terminated")))
        .then((rows) => rows[0] ?? null);
      return agent !== null;
    }
    const member = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.principalId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return member !== null;
  }

  /**
   * Replaces every memory right of one principal with `permissions`. Any other
   * memory row it held (`memory:admin`, `memory:delete`, a client scope) goes.
   */
  async function set(caller: MemoryCaller, body: unknown): Promise<MemoryGrant> {
    const parsed = setMemoryGrantsSchema.safeParse(body);
    const target = parsed.success
      ? { principalType: parsed.data.principalType, principalId: parsed.data.principalId }
      : {};
    await assertOwner(caller, "grant_set", target);
    if (!parsed.success) {
      await logOperation(caller, "grant_set", "denied", {
        detail: {
          reason: "invalid_body",
          invalidFields: parsed.error.issues.map((issue) => issue.path.join(".") || issue.code),
        },
      });
      throw badRequest("Invalid memory grant", parsed.error.issues);
    }
    const input = parsed.data;
    if (!(await principalExists(caller.companyId, input))) {
      await logOperation(caller, "grant_set", "denied", { detail: { reason: "unknown_principal", ...target } });
      throw notFound(input.principalType === "agent" ? "Agent not found" : "Member not found");
    }
    const permissions = [...new Set(input.permissions)] as MemoryGrantablePermission[];
    const now = new Date();
    const before = await db.transaction(async (tx) => {
      const principal = and(
        eq(principalPermissionGrants.companyId, caller.companyId),
        eq(principalPermissionGrants.principalType, input.principalType),
        eq(principalPermissionGrants.principalId, input.principalId),
        like(principalPermissionGrants.permissionKey, "memory:%"),
      );
      const removed = await tx
        .delete(principalPermissionGrants)
        .where(principal)
        .returning({ key: principalPermissionGrants.permissionKey, scope: principalPermissionGrants.scope });
      if (permissions.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          permissions.map((permissionKey) => ({
            companyId: caller.companyId,
            principalType: input.principalType,
            principalId: input.principalId,
            permissionKey,
            scope: null,
            grantedByUserId: caller.userId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      return removed;
    });
    await logOperation(caller, "grant_set", "ok", {
      detail: {
        ...target,
        before: before.map((row) => (row.scope ? { key: row.key, scope: row.scope } : row.key)),
        after: permissions,
        reason: input.reason,
      },
    });
    return {
      principalType: input.principalType,
      principalId: input.principalId,
      permissions,
      grantedByUserId: caller.userId,
      updatedAt: now,
    };
  }

  return { list, set };
}
