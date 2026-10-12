import { and, eq, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { authAccounts, authUsers, companyMemberships, principalPermissionGrants, type Db } from "@greatstone/db";
import { describe, expect, it } from "vitest";
import { CLIENT_BOARD_PERMISSION, addClientUsers, parseClientUserList } from "../services/client-users.js";
import { BOARD_MEMBER_PERMISSION, strategyBoardService } from "../services/strategy-board.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const LIST = [
  "name,email,role",
  "Ada Board,ada@example.test,board",
  '"Kofi, Exco",Kofi@Example.test,exco',
  "Ola Owner,ola@example.test,owner",
  "",
  "# Greatstone keeps this list off the app",
].join("\n");

let counter = 0;
const makePassword = () => `sandbox-password-${(counter += 1)}`;

describe("parseClientUserList (GRE-1189)", () => {
  it("reads name, email and role; skips the header, blank lines and comments", () => {
    const { rows, problems } = parseClientUserList(LIST);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { line: 2, name: "Ada Board", email: "ada@example.test", role: "board" },
      { line: 3, name: "Kofi, Exco", email: "kofi@example.test", role: "exco" },
      { line: 4, name: "Ola Owner", email: "ola@example.test", role: "owner" },
    ]);
  });

  it("reports every bad row with its line and keeps only the good ones", () => {
    const { rows, problems } = parseClientUserList(
      ["Good One,good@example.test,board", ",empty@example.test,board", "No Mail,not-an-email,exco", "Wrong Role,role@example.test,chairman", "Too,few", "Again,GOOD@example.test,owner"].join("\n"),
    );
    expect(rows.map((r) => r.email)).toEqual(["good@example.test"]);
    expect(problems).toEqual([
      { line: 2, message: "name is empty" },
      { line: 3, message: '"not-an-email" is not an email address' },
      { line: 4, message: 'role "chairman" is not one of: board, exco, admin, owner' },
      { line: 5, message: "needs 3 fields (name, email, role), found 2" },
      { line: 6, message: "good@example.test is listed already on line 1" },
    ]);
  });

  it("uses the same board right as the board control panel", () => {
    expect(CLIENT_BOARD_PERMISSION).toBe(BOARD_MEMBER_PERMISSION);
  });
});

describeEmbeddedPostgres("addClientUsers (GRE-1189)", () => {
  const ctx = useEmbeddedPostgres("gsam-client-users-", {
    resetEach: async (db) => {
      await resetCompanyIssueFixtures(db);
      await db.delete(authAccounts);
      await db.delete(authUsers);
    },
  });

  async function grantKeys(db: Db, companyId: string, email: string) {
    const user = await db.select().from(authUsers).where(eq(authUsers.email, email)).then((r) => r[0]!);
    const rows = await db
      .select({ key: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, user.id)));
    return rows.map((r) => r.key).sort();
  }

  async function counts(db: Db) {
    const n = async (table: typeof authUsers | typeof authAccounts | typeof companyMemberships | typeof principalPermissionGrants) =>
      db.select({ n: sql<number>`count(*)::int` }).from(table).then((r) => r[0]!.n);
    return { users: await n(authUsers), accounts: await n(authAccounts), memberships: await n(companyMemberships), grants: await n(principalPermissionGrants) };
  }

  it("creates each log-in with the right company role, rights and a working password", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Client");
    const { rows } = parseClientUserList(LIST);
    const results = await addClientUsers(ctx.db, { companyId, rows, makePassword });
    expect(results.map((r) => [r.email, r.outcome])).toEqual([
      ["ada@example.test", "created"],
      ["kofi@example.test", "created"],
      ["ola@example.test", "created"],
    ]);

    const members = await strategyBoardService(ctx.db).listMembers(companyId);
    const byEmail = new Map(members.map((m) => [m.email, m]));
    expect(byEmail.get("ada@example.test")).toMatchObject({ role: "viewer", isBoardMember: true, name: "Ada Board" });
    expect(byEmail.get("kofi@example.test")).toMatchObject({ role: "admin", isBoardMember: false, name: "Kofi, Exco" });
    // Owners and admins act on the board through their role (boardViewerRights), not the board-member right.
    expect(byEmail.get("ola@example.test")).toMatchObject({ role: "owner", isBoardMember: false });

    expect(await grantKeys(ctx.db, companyId, "ada@example.test")).toEqual(["strategy:board_member"]);
    expect(await grantKeys(ctx.db, companyId, "kofi@example.test")).toContain("users:invite");
    expect(await grantKeys(ctx.db, companyId, "ola@example.test")).toContain("users:manage_permissions");

    const ada = await ctx.db.select().from(authUsers).where(eq(authUsers.email, "ada@example.test")).then((r) => r[0]!);
    const account = await ctx.db.select().from(authAccounts).where(eq(authAccounts.userId, ada.id)).then((r) => r[0]!);
    expect(account).toMatchObject({ providerId: "credential", issuer: "local:credential", accountId: ada.id });
    expect(await verifyPassword({ hash: account.password!, password: results[0]!.password! })).toBe(true);
  });

  it("changes nothing on a second run with the same list", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Client");
    const { rows } = parseClientUserList(LIST);
    await addClientUsers(ctx.db, { companyId, rows, makePassword });
    const before = await counts(ctx.db);
    const again = await addClientUsers(ctx.db, { companyId, rows, makePassword });
    expect(again.map((r) => r.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(again.every((r) => r.password === undefined)).toBe(true);
    expect(await counts(ctx.db)).toEqual(before);
  });

  it("refuses to change the role of an existing log-in, and adds only what is missing", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Client");
    await addClientUsers(ctx.db, { companyId, rows: parseClientUserList("Ola Owner,ola@example.test,owner").rows, makePassword });
    const before = await counts(ctx.db);
    const [refused] = await addClientUsers(ctx.db, { companyId, rows: parseClientUserList("Ola Owner,ola@example.test,board").rows, makePassword });
    expect(refused).toMatchObject({ outcome: "refused", detail: expect.stringContaining("company role owner") });
    expect(await counts(ctx.db)).toEqual(before);

    // A board member whose board right was taken off gets it back, nothing else.
    await addClientUsers(ctx.db, { companyId, rows: parseClientUserList("Ada Board,ada@example.test,board").rows, makePassword });
    await ctx.db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.permissionKey, "strategy:board_member"));
    const [added] = await addClientUsers(ctx.db, { companyId, rows: parseClientUserList("Ada Board,ada@example.test,board").rows, makePassword });
    expect(added).toMatchObject({ outcome: "added", detail: "existing log-in; added rights strategy:board_member" });
  });

  it("dry run reports the same outcomes and writes nothing", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Client");
    const before = await counts(ctx.db);
    const results = await addClientUsers(ctx.db, { companyId, rows: parseClientUserList(LIST).rows, makePassword, dryRun: true });
    expect(results.map((r) => r.outcome)).toEqual(["created", "created", "created"]);
    expect(results.every((r) => r.password === undefined)).toBe(true);
    expect(await counts(ctx.db)).toEqual(before);
  });

  it("a row that fails part way leaves nothing behind", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Client");
    const before = await counts(ctx.db);
    // A company that does not exist fails at the membership insert, after the user and account rows.
    await expect(
      addClientUsers(ctx.db, { companyId: "00000000-0000-0000-0000-000000000000", rows: parseClientUserList("Ada Board,ada@example.test,board").rows, makePassword }),
    ).rejects.toThrow();
    expect(await counts(ctx.db)).toEqual(before);
    void companyId;
  });
});
