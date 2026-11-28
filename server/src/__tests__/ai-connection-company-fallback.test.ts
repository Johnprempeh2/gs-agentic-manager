import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, connectionGrantMembers, createDb, toolConnectionInstalls } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

// A new member can prompt agents from first sign-in: with no personal default,
// a run uses the company-shared account an admin connected once. The key stays
// in company secrets, the member's own default still wins, and the fallback
// never crosses companies or bypasses who the admin shared the account with.

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "gsam-ai-company-fallback-"));
  vi.stubEnv("GSAM_HOME", home);
  vi.stubEnv("GSAM_INSTANCE_ID", "ai-company-fallback");
  database = await startEmbeddedPostgresTestDatabase("gsam-ai-company-fallback-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
const SHARED_KEY = "company-shared-anthropic-key";

async function company(options: { sharedForAllAgents?: boolean } = {}) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const adminId = `admin-${companyId}`;
  const newMemberId = `member-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Fallback test", issuePrefix: `F${companyId.slice(0, 7)}`, defaultResponsibleUserId: adminId });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: adminId, membershipRole: "owner", status: "active" },
    { companyId, principalType: "user", principalId: newMemberId, membershipRole: "member", status: "active" },
  ]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Everest", role: "ceo", adapterType: "claude_local", adapterConfig: { cwd: home }, runtimeConfig: { aiConnection: binding } });
  const shared = await aiConnectionService(db).save(companyId, adminId, {
    provider: "anthropic", method: "api_key", name: "Company Claude key", ownership: "shared",
    apiKey: SHARED_KEY, agentIds: [], allAgents: options.sharedForAllAgents ?? true,
  }, SHARED_KEY);
  return { companyId, agentId, adminId, newMemberId, shared };
}

function prepare(f: { companyId: string; agentId: string }, responsibleUserId: string) {
  return prepareManagedAiRuntime(db, {
    companyId: f.companyId, agentId: f.agentId, responsibleUserId, adapterType: "claude_local",
    binding, config: { cwd: home },
  });
}

describe("company-shared AI account fallback", () => {
  it("lets a new member with no personal default run agents on the company account", async () => {
    const f = await company();
    const runtime = await prepare(f, f.newMemberId);
    try {
      expect(runtime.attribution).toMatchObject({
        connectionId: f.shared.connectionId, grantId: f.shared.grantId,
        mode: "shared", responsibleUserId: f.newMemberId,
      });
      expect((runtime.config.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBe(SHARED_KEY);
    } finally { await runtime.cleanup(); }
  });

  it("never shows the company key to the member", async () => {
    const f = await company();
    const accounts = await aiConnectionService(db).list(f.companyId, f.newMemberId);
    expect(accounts.find((account) => account.id === f.shared.connectionId)).toMatchObject({ ownership: "shared" });
    expect(JSON.stringify(accounts)).not.toContain(SHARED_KEY);
  });

  it("keeps the member's own default ahead of the company account", async () => {
    const f = await company();
    const ownKey = "member-own-key";
    const own = await aiConnectionService(db).save(f.companyId, f.newMemberId, {
      provider: "anthropic", method: "api_key", name: "My key", ownership: "personal",
      apiKey: ownKey, agentIds: [f.agentId], allAgents: false,
    }, ownKey);
    const runtime = await prepare(f, f.newMemberId);
    try {
      expect(runtime.attribution).toMatchObject({ grantId: own.grantId, mode: "responsible_user" });
      expect((runtime.config.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBe(ownKey);
    } finally { await runtime.cleanup(); }
  });

  it("refuses someone who is not an active member", async () => {
    const f = await company();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.newMemberId));
    await expect(prepare(f, f.newMemberId)).rejects.toMatchObject({ status: 403 });
  });

  it("respects an account the admin shared with named people only", async () => {
    const f = await company();
    await db.insert(connectionGrantMembers).values({ companyId: f.companyId, grantId: f.shared.grantId, subjectType: "user", subjectId: f.adminId });
    await expect(prepare(f, f.newMemberId)).rejects.toMatchObject({ details: { code: "ai_connection_default_missing" } });
  });

  it("uses only a company account the admin permitted for the agent", async () => {
    const f = await company({ sharedForAllAgents: false });
    await expect(prepare(f, f.newMemberId)).rejects.toMatchObject({ details: { code: "ai_connection_default_missing" } });
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.shared.connectionId, targetType: "agent", targetId: f.agentId });
    const runtime = await prepare(f, f.newMemberId);
    try {
      expect(runtime.attribution).toMatchObject({ grantId: f.shared.grantId, mode: "shared" });
    } finally { await runtime.cleanup(); }
  });

  it("never falls back to another company's shared account", async () => {
    const other = await company();
    const f = await company();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: other.newMemberId, membershipRole: "member", status: "active" });
    // f's own shared account is the only one it may use; remove it and the
    // other company's account must still not be chosen.
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.shared.connectionId));
    await expect(prepare(f, other.newMemberId)).rejects.toMatchObject({ details: { code: "ai_connection_default_missing" } });
  });
});
