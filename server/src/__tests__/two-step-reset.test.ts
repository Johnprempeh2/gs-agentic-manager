import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, companies, companyMemberships, createDb, instanceUserRoles } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { describeMemberTwoStepControls, twoStepResetRefusal } from "../services/two-step-reset.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("who may reset two-step sign-in", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const members = new Map<string, { id: string; principalType: string; principalId: string; membershipRole: string; status: string }>();

  async function addUser(id: string, twoFactorEnabled = true) {
    await db.insert(authUsers).values({
      id,
      name: id,
      email: `${id}@example.com`,
      twoFactorEnabled,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function addMember(company: string, userId: string, membershipRole: string) {
    const [row] = await db
      .insert(companyMemberships)
      .values({ companyId: company, principalType: "user", principalId: userId, status: "active", membershipRole })
      .returning();
    if (company === companyId) members.set(userId, row as never);
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-two-step-reset-");
    db = createDb(database.connectionString);
    for (const [id, prefix] of [[companyId, "TSA"], [otherCompanyId, "TSB"]] as const) {
      await db.insert(companies).values({ id, name: id, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    }
    for (const id of ["owner", "admin", "operator", "viewer", "elsewhere", "root", "off"]) {
      await addUser(id, id !== "off");
    }
    await addMember(companyId, "owner", "owner");
    await addMember(companyId, "admin", "admin");
    await addMember(companyId, "operator", "operator");
    await addMember(companyId, "viewer", "viewer");
    await addMember(companyId, "elsewhere", "operator");
    await addMember(otherCompanyId, "elsewhere", "operator");
    await addMember(companyId, "root", "operator");
    await addMember(companyId, "off", "operator");
    await db.insert(instanceUserRoles).values({ userId: "root", role: "instance_admin" });
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  const session = (userId: string, isInstanceAdmin = false) => ({
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin,
  });
  const refuse = (actorId: string, targetId: string, isInstanceAdmin = false) =>
    twoStepResetRefusal(db, { actor: session(actorId, isInstanceAdmin), companyId, member: members.get(targetId)! });

  it("lets an owner or admin reset someone below their role in this organisation only", async () => {
    expect(await refuse("owner", "admin")).toBeNull();
    expect(await refuse("admin", "operator")).toBeNull();
    expect(await refuse("owner", "viewer")).toBeNull();
    expect(await refuse("operator", "viewer")).toMatch(/owner or admin/);
    expect(await refuse("admin", "owner")).toMatch(/below your role/);
    expect(await refuse("owner", "owner")).toMatch(/your profile/);
    expect(await refuse("owner", "elsewhere")).toMatch(/another organisation/);
    expect(await refuse("owner", "root")).toMatch(/instance admin/);
  });

  it("lets an instance admin reset anyone but themselves", async () => {
    expect(await refuse("root", "owner", true)).toBeNull();
    expect(await refuse("root", "elsewhere", true)).toBeNull();
    expect(await refuse("root", "root", true)).toMatch(/your profile/);
  });

  it("offers the reset only on rows with two-step sign-in on", async () => {
    const controls = await describeMemberTwoStepControls(db, {
      actor: session("owner"),
      companyId,
      members: [...members.values()],
    });
    expect(controls.get(members.get("operator")!.id)).toEqual({ enabled: true, canReset: true, resetReason: null });
    expect(controls.get(members.get("off")!.id)).toMatchObject({ enabled: false, canReset: false });
    expect(controls.get(members.get("owner")!.id)).toMatchObject({ enabled: true, canReset: false });
  });
});
