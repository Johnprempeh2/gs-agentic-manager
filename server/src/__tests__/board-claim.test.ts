import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  aiConnectionDefaults,
  aiProviderDefaults,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
  inspectBoardClaimChallenge,
} from "../board-claim.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lets a signed-in user claim a local-board-only authenticated instance", async () => {
    const now = new Date();
    const userId = `claim-user-${randomUUID()}`;
    const company = await db
      .insert(companies)
      .values({
        name: "Board Claim Co",
        issuePrefix: `BC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(authUsers).values({
      id: userId,
      name: "Board Claim User",
      email: "board-claim@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();

    const parsed = new URL(warningUrl!);
    const token = parsed.pathname.split("/").pop()!;
    const code = parsed.searchParams.get("code")!;

    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "available",
      requiresSignIn: true,
      claimedByUserId: null,
    });

    await expect(
      claimBoardOwnership(db, { token, code, userId }),
    ).resolves.toEqual({
      status: "claimed",
      claimedByUserId: userId,
    });

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, "local-board"), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([
      {
        status: "active",
        membershipRole: "owner",
      },
    ]);
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
  });

  it("hands the board identity's personal AI account and defaults to the claimer", async () => {
    const userId = `claim-user-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Claim AI Co", issuePrefix: `CA${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: "claim-ai", name: "Claude", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, name: "My Claude subscription", uid: `ai-${randomUUID()}`, connectionPurpose: "ai", transport: "runtime_auth", authKind: "api_key", credentialPolicy: "per_user", config: { ai: { provider: "anthropic", method: "subscription" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: "local-board", createdByUserId: "local-board" }).returning();
    await db.insert(aiProviderDefaults).values({ companyId, userId: "local-board", provider: "anthropic", grantId: grant!.id });
    await db.insert(aiConnectionDefaults).values({ companyId, userId: "local-board", provider: "anthropic", method: "subscription", grantId: grant!.id });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const parsed = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    await claimBoardOwnership(db, { token: parsed.pathname.split("/").pop()!, code: parsed.searchParams.get("code")!, userId });

    const [moved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
    expect(moved!.subjectUserId).toBe(userId);
    expect((await db.select().from(aiProviderDefaults).where(eq(aiProviderDefaults.companyId, companyId))).map((row) => row.userId)).toEqual([userId]);
    expect((await db.select().from(aiConnectionDefaults).where(eq(aiConnectionDefaults.companyId, companyId))).map((row) => row.userId)).toEqual([userId]);
  });
});
