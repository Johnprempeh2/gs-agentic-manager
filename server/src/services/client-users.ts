// Add a client's board, Exco and owner log-ins from a list (GRE-1189).
// Greatstone runs it on the host through `scripts/client-instance.sh users`;
// invites and sign-up stay closed for the client. It writes the same rows a
// sign-up plus an accepted invite would: a Better Auth user and its
// email/password account, an active company membership, the role's default
// grants and, for board members, the board right from GRE-1135.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { authAccounts, authUsers, companyMemberships, principalPermissionGrants, type Db } from "@greatstone/db";
import type { HumanCompanyMembershipRole, PermissionKey } from "@greatstone/shared";
import { grantsForHumanRole } from "./company-member-roles.js";

/** Same key as BOARD_MEMBER_PERMISSION in strategy-board.ts; that module is not imported because the host script loads this one. */
export const CLIENT_BOARD_PERMISSION: PermissionKey = "strategy:board_member";

/** The words a list may use, and the company role each one gets. */
export const CLIENT_USER_ROLES = {
  board: "viewer",
  exco: "admin",
  admin: "admin",
  owner: "owner",
} as const satisfies Record<string, HumanCompanyMembershipRole>;
export type ClientUserRole = keyof typeof CLIENT_USER_ROLES;

export interface ClientUserRow {
  /** 1-based line in the list. */
  line: number;
  name: string;
  email: string;
  role: ClientUserRole;
}

export interface ClientUserListProblem {
  line: number;
  message: string;
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_NAME_LENGTH = 200;

/** One CSV line: commas split fields, double quotes may wrap a field ("" is a quote). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/**
 * Reads a `name,email,role` list. A header line, blank lines and lines that
 * start with # are skipped. Every bad row is reported; the caller writes
 * nothing while any problem is left.
 */
export function parseClientUserList(text: string): { rows: ClientUserRow[]; problems: ClientUserListProblem[] } {
  const rows: ClientUserRow[] = [];
  const problems: ClientUserListProblem[] = [];
  const firstLineByEmail = new Map<string, number>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const fields = splitCsvLine(trimmed);
    if (fields.map((f) => f.toLowerCase()).join(",") === "name,email,role") return;
    if (fields.length !== 3) {
      problems.push({ line, message: `needs 3 fields (name, email, role), found ${fields.length}` });
      return;
    }
    const [name, rawEmail, rawRole] = fields as [string, string, string];
    const email = rawEmail.toLowerCase();
    const role = rawRole.toLowerCase();
    const before = problems.length;
    if (!name) problems.push({ line, message: "name is empty" });
    else if (name.length > MAX_NAME_LENGTH) problems.push({ line, message: `name is longer than ${MAX_NAME_LENGTH} characters` });
    if (!EMAIL_PATTERN.test(email)) problems.push({ line, message: `"${rawEmail}" is not an email address` });
    if (!Object.hasOwn(CLIENT_USER_ROLES, role)) {
      problems.push({ line, message: `role "${rawRole}" is not one of: ${Object.keys(CLIENT_USER_ROLES).join(", ")}` });
    }
    const firstLine = firstLineByEmail.get(email);
    if (firstLine !== undefined) problems.push({ line, message: `${email} is listed already on line ${firstLine}` });
    else if (EMAIL_PATTERN.test(email)) firstLineByEmail.set(email, line);
    if (problems.length === before) rows.push({ line, name, email, role: role as ClientUserRole });
  });
  return { rows, problems };
}

export type ClientUserOutcome =
  /** New log-in made; `password` is set and shown once. */
  | "created"
  /** The log-in existed; it now has the membership, role grants or board right it lacked. */
  | "added"
  /** Already as the list says. */
  | "unchanged"
  /** Not changed, because the log-in already has another role or a membership that is not active. */
  | "refused";

export interface ClientUserResult {
  line: number;
  email: string;
  role: ClientUserRole;
  outcome: ClientUserOutcome;
  detail: string;
  password?: string;
}

function grantKeysFor(role: ClientUserRole): string[] {
  const membershipRole = CLIENT_USER_ROLES[role];
  return [
    ...grantsForHumanRole(membershipRole).map((grant) => grant.permissionKey),
    ...(role === "board" ? [CLIENT_BOARD_PERMISSION] : []),
  ];
}

/**
 * Adds each row to the company. One transaction per row, so a row that fails
 * leaves nothing behind. A second run with the same list changes nothing.
 * An existing log-in with another role is refused, not changed: a list must
 * never quietly demote an owner. `dryRun` reports the same outcomes and
 * writes nothing.
 */
export async function addClientUsers(
  db: Db,
  input: { companyId: string; rows: ClientUserRow[]; makePassword: () => string; dryRun?: boolean },
): Promise<ClientUserResult[]> {
  const results: ClientUserResult[] = [];
  for (const row of input.rows) {
    const membershipRole = CLIENT_USER_ROLES[row.role];
    const wantKeys = grantKeysFor(row.role);
    const base = { line: row.line, email: row.email, role: row.role };
    const result = await db.transaction(async (tx): Promise<ClientUserResult> => {
      const user = await tx
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(sql`lower(${authUsers.email}) = ${row.email}`)
        .then((rows) => rows[0] ?? null);

      if (!user) {
        const password = input.makePassword();
        if (!input.dryRun) {
          const userId = randomUUID();
          const now = new Date();
          await tx.insert(authUsers).values({ id: userId, name: row.name, email: row.email, emailVerified: false, createdAt: now, updatedAt: now });
          await tx.insert(authAccounts).values({
            id: randomUUID(),
            issuer: "local:credential",
            accountId: userId,
            providerId: "credential",
            userId,
            password: await hashPassword(password),
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(companyMemberships).values({
            companyId: input.companyId,
            principalType: "user",
            principalId: userId,
            status: "active",
            membershipRole,
          });
          await insertGrants(tx, input.companyId, userId, wantKeys);
        }
        return { ...base, outcome: "created", detail: `new log-in, company role ${membershipRole}`, password: input.dryRun ? undefined : password };
      }

      const membership = await tx
        .select({ status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, user.id),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (membership && membership.status !== "active") {
        return { ...base, outcome: "refused", detail: `membership is ${membership.status}; not changed` };
      }
      if (membership && membership.membershipRole !== membershipRole) {
        return { ...base, outcome: "refused", detail: `log-in has company role ${membership.membershipRole ?? "none"}, the list says ${membershipRole}; not changed` };
      }

      const haveKeys = new Set(
        await tx
          .select({ key: principalPermissionGrants.permissionKey })
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, input.companyId),
              eq(principalPermissionGrants.principalType, "user"),
              eq(principalPermissionGrants.principalId, user.id),
              inArray(principalPermissionGrants.permissionKey, wantKeys.length ? wantKeys : ["-"]),
            ),
          )
          .then((rows) => rows.map((r) => r.key)),
      );
      const missingKeys = wantKeys.filter((key) => !haveKeys.has(key));
      if (membership && missingKeys.length === 0) {
        return { ...base, outcome: "unchanged", detail: `already company role ${membershipRole}` };
      }
      if (!input.dryRun) {
        if (!membership) {
          await tx.insert(companyMemberships).values({
            companyId: input.companyId,
            principalType: "user",
            principalId: user.id,
            status: "active",
            membershipRole,
          });
        }
        await insertGrants(tx, input.companyId, user.id, missingKeys);
      }
      const added = [...(membership ? [] : [`membership as ${membershipRole}`]), ...(missingKeys.length ? [`rights ${missingKeys.join(", ")}`] : [])];
      return { ...base, outcome: "added", detail: `existing log-in; added ${added.join(" and ")}` };
    });
    results.push(result);
  }
  return results;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function insertGrants(tx: Tx, companyId: string, userId: string, keys: string[]) {
  if (keys.length === 0) return;
  const now = new Date();
  await tx
    .insert(principalPermissionGrants)
    .values(
      keys.map((permissionKey) => ({
        companyId,
        principalType: "user",
        principalId: userId,
        permissionKey,
        scope: null,
        grantedByUserId: null,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}
