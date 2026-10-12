// A personal AI account saved before sign-in must still work after the board
// is claimed: the grant, its stored key and the right to reconnect all move.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  instanceUserRoles,
  toolConnections,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
} from "../board-claim.js";
import { aiConnectionService } from "../services/ai-connections.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("board claim and personal AI credentials", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "board-claim-ai-"));
    vi.stubEnv("GSAM_HOME", home);
    vi.stubEnv("GSAM_INSTANCE_ID", "board-claim-ai");
    tempDb = await startEmbeddedPostgresTestDatabase("board-claim-ai-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("the handed-over account still resolves, and its new owner can reconnect it", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Claim AI", issuePrefix: `CL${companyId.slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: "local-board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });

    const svc = aiConnectionService(db);
    const account = await svc.save(companyId, "local-board", {
      provider: "anthropic", method: "api_key", name: "My key", ownership: "personal",
      apiKey: "sk-ant-scratch", agentIds: [], allAgents: true,
    }, "sk-ant-scratch");

    const load = async () => {
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
      return { grant: grant!, connection: connection! };
    };
    // Before the claim the personal key resolves.
    await expect(svc.credential((await load()) as never)).resolves.toBe("sk-ant-scratch");

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const url = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    const claimer = `claimer-${randomUUID()}`;
    await claimBoardOwnership(db, { token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")!, userId: claimer });

    const after = await load();
    expect(after.grant.subjectUserId).toBe(claimer); // the grant moved
    const ref = after.grant.credentialSecretRefs.find((r) => r.configPath === "ai.credential")!;
    const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.id, ref.secretId), eq(companySecrets.companyId, companyId)));
    expect(secret!.scope).toBe("user");
    expect(secret!.ownerUserId).toBe(claimer); // and so did its stored key

    await expect(svc.credential(after as never)).resolves.toBe("sk-ant-scratch");
    await expect(svc.save(companyId, claimer, {
      provider: "anthropic", method: "api_key", name: "My key", ownership: "personal",
      apiKey: "sk-ant-new", agentIds: [], allAgents: true, connectionId: account.connectionId,
    }, "sk-ant-new")).resolves.toBeTruthy();
  });
});
