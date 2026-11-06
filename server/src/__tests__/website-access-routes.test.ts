import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueApprovals,
  issueComments,
  issues,
  principalPermissionGrants,
  secretAccessEvents,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteDataBridgeKey } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { instanceSettingsService } from "../services/index.js";
import { createWebsiteBridgeClient, parseBridgeCredential, bridgeCanonicalQuery, bridgeCanonicalString } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

// A decided card wakes its asker; record the wake instead of starting an agent run in the test database.
const wakeups = vi.hoisted(() => [] as Array<{ agentId: string; opts: Record<string, unknown> }>);
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async (agentId: string, opts: Record<string, unknown>) => { wakeups.push({ agentId, opts }); return null; },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website access tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Seen = { method: string; path: string; body: string; headers: Record<string, string>; verified: boolean; replayed: boolean };

const OWNER = "a0000000-0000-4000-8000-000000000001";
const EDITOR = "a0000000-0000-4000-8000-000000000002";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const MEMBER = "d0000000-0000-4000-8000-000000000001";

// GRE-4085: people and access through the bridge (contract "People and access"). The fake site checks each signature
// with the public key the key route gave out, keeps answers by idempotency key, refuses an agent or system actor on
// every change (403 denied) and keeps one active owner (409 conflict), as greatstone-website's accessRoute does.
describeEmbeddedPostgres("website people and access routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-access-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  let publicKeys = new Map<string, string>();
  let seen: Seen[] = [];
  let stored = new Map<string, { bodySha: string; answer: { status: number; body: unknown } }>();
  /** How many answers the network loses after the site has acted. */
  let lose = 0;

  type Staff = { id: string; email: string; name: string; role: string; isActive: boolean; canSignIn: boolean; portalApprover: boolean;
    lastLoginAt: null; updatedAt: string };
  let staff: Staff[] = [];
  let approvers: Array<{ staffId: string; label: string; addedAt: string }> = [];
  let members: Array<{ membershipId: string; organisationId: string; userId: string | null; email: string; name: string; role: string;
    isPrimary: boolean; createdAt: string; updatedAt: string }> = [];
  let tick = 0;
  const stamp = () => `2026-11-05T12:00:${String(tick++).padStart(2, "0")}Z`;

  function resetSite() {
    tick = 0;
    staff = [
      { id: OWNER, email: "owner@example.test", name: "Olu Owner", role: "owner", isActive: true, canSignIn: true, portalApprover: false, lastLoginAt: null, updatedAt: stamp() },
      { id: EDITOR, email: "ed@example.test", name: "Ed Editor", role: "editor", isActive: true, canSignIn: true, portalApprover: false, lastLoginAt: null, updatedAt: stamp() },
    ];
    approvers = [];
    members = [{ membershipId: MEMBER, organisationId: CLIENT, userId: "u1", email: "ann@client.example.test", name: "Ann Client", role: "member",
      isPrimary: true, createdAt: stamp(), updatedAt: stamp() }];
  }

  const approverRows = () => approvers.map((a) => {
    const s = staff.find((x) => x.id === a.staffId)!;
    return { staffId: a.staffId, email: s.email, name: s.name, label: a.label, staffActive: s.isActive, addedAt: a.addedAt };
  });

  function siteAnswer(method: string, p: string, body: Record<string, unknown> | undefined, actor: string): { status: number; body: unknown } {
    if (method === "GET") {
      if (p === "access/staff") return { status: 200, body: { items: staff, nextCursor: null } };
      if (p === "access/portal-approvers") return { status: 200, body: { items: approverRows(), nextCursor: null } };
      const m = /^access\/clients\/([^/]+)\/members$/.exec(p);
      if (m) return m[1] === CLIENT ? { status: 200, body: { items: members, nextCursor: null } } : { status: 404, body: { error: { code: "not_found" } } };
      return { status: 404, body: { error: { code: "not_found" } } };
    }
    if (!actor.startsWith("user:")) return { status: 403, body: { error: { code: "denied" } } };
    let m: RegExpExecArray | null;
    if ((m = /^access\/staff\/([^/]+)$/.exec(p)) && method === "PATCH") {
      const s = staff.find((x) => x.id === m![1]);
      if (!s) return { status: 404, body: { error: { code: "not_found" } } };
      if (s.role === "owner" && body!.role !== "owner" && staff.filter((x) => x.role === "owner" && x.isActive).length === 1) {
        return { status: 409, body: { error: { code: "conflict" } } };
      }
      if (s.role !== body!.role) Object.assign(s, { role: body!.role, updatedAt: stamp() });
      return { status: 200, body: { item: s } };
    }
    if ((m = /^access\/portal-approvers\/([^/]+)$/.exec(p))) {
      const s = staff.find((x) => x.id === m![1]);
      if (!s) return { status: 404, body: { error: { code: "not_found" } } };
      const at = approvers.findIndex((a) => a.staffId === s.id);
      if (method === "PUT") {
        if (at >= 0) approvers[at]!.label = String(body!.label);
        else approvers.push({ staffId: s.id, label: String(body!.label), addedAt: stamp() });
        s.portalApprover = true;
        return { status: at >= 0 ? 200 : 201, body: { item: approverRows().find((a) => a.staffId === s.id) } };
      }
      if (at < 0) return { status: 404, body: { error: { code: "not_found" } } };
      approvers.splice(at, 1);
      s.portalApprover = false;
      return { status: 200, body: { staffId: s.id, removed: true } };
    }
    if ((m = /^access\/clients\/([^/]+)\/members$/.exec(p)) && method === "POST") {
      if (m[1] !== CLIENT) return { status: 404, body: { error: { code: "not_found" } } };
      if (staff.some((s) => s.email === body!.email) || members.some((x) => x.email === body!.email)) return { status: 409, body: { error: { code: "conflict" } } };
      const row = { membershipId: randomUUID(), organisationId: CLIENT, userId: "u2", email: String(body!.email), name: String(body!.name),
        role: String(body!.role), isPrimary: false, createdAt: stamp(), updatedAt: stamp() };
      members.push(row);
      return { status: 201, body: { item: row } };
    }
    if ((m = /^access\/clients\/([^/]+)\/members\/([^/]+)$/.exec(p))) {
      const row = members.find((x) => x.organisationId === m![1] && x.membershipId === m![2]);
      if (!row) return { status: 404, body: { error: { code: "not_found" } } };
      if (method === "PATCH") {
        Object.assign(row, { role: body!.role, updatedAt: stamp() });
        return { status: 200, body: { item: row } };
      }
      members = members.filter((x) => x !== row);
      return { status: 200, body: { membershipId: row.membershipId, organisationId: row.organisationId, removed: true } };
    }
    return { status: 404, body: { error: { code: "not_found" } } };
  }

  const fakeSite = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : "";
    const bodySha = createHash("sha256").update(body).digest("hex");
    const pub = publicKeys.get(headers["x-gs-bridge-key"]!);
    const idempotencyKey = headers["x-gs-bridge-idempotency-key"];
    const canonical = bridgeCanonicalString({ method: String(init.method), host: url.host, path: url.pathname,
      query: bridgeCanonicalQuery(url.searchParams), time: Number(headers["x-gs-bridge-time"]), nonce: headers["x-gs-bridge-nonce"]!,
      actor: headers["x-gs-bridge-actor"]!, run: headers["x-gs-bridge-run"] ?? null, bodySha256: bodySha, idempotencyKey });
    const verified = Boolean(pub) && (idempotencyKey ? canonical.startsWith("gs-bridge-v2\n") : String(init.method) === "GET")
      && verify(null, Buffer.from(canonical), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub! }, format: "jwk" }),
        Buffer.from(headers["x-gs-bridge-signature"]!, "base64url"));
    const pathName = url.pathname.replace("/api/admin/v1/", "");
    const prior = idempotencyKey ? stored.get(`${headers["x-gs-bridge-key"]}:${idempotencyKey}`) : undefined;
    seen.push({ method: String(init.method), path: pathName, body, headers, verified, replayed: Boolean(prior && prior.bodySha === bodySha) });
    if (!verified) return Response.json({ error: { code: "bad_signature" } }, { status: 401 });
    if (prior) {
      if (prior.bodySha !== bodySha) return Response.json({ error: { code: "idempotency_mismatch" } }, { status: 409 });
      if (lose > 0) { lose -= 1; throw new TypeError("fetch failed"); }
      return Response.json(prior.answer.body, { status: prior.answer.status });
    }
    const out = siteAnswer(String(init.method), pathName, body ? JSON.parse(body) : undefined, headers["x-gs-bridge-actor"]!);
    if (idempotencyKey) stored.set(`${headers["x-gs-bridge-key"]}:${idempotencyKey}`, { bodySha, answer: out });
    if (idempotencyKey && lose > 0 && out.status < 300) { lose -= 1; throw new TypeError("fetch failed"); }
    return Response.json(out.body, { status: out.status });
  }) as unknown as typeof fetch;
  const bridgeOptions: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value),
      fetchImpl: fakeSite, sleep: async () => {} }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-access-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    publicKeys = new Map();
    seen = [];
    stored = new Map();
    lose = 0;
    wakeups.length = 0;
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(issueApprovals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(websiteSite);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  const board: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = board) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", websiteDataBridgeRoutes(db, bridgeOptions));
    instance.use("/api", approvalRoutes(db, { websiteDataBridge: bridgeOptions }));
    instance.use(errorHandler);
    return instance;
  }

  async function makeKey(base: string, capability: "read" | "write") {
    const key = (await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability }).expect(201)).body as WebsiteDataBridgeKey;
    publicKeys.set(key.keyId, key.publicKey);
    return key;
  }

  async function seedWorld({ write = true } = {}) {
    resetSite();
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const site = (await request(app()).post(`/api/companies/${companyId}/website/sites`)
      .send({ name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" }).expect(201)).body;
    const base = `/api/companies/${companyId}/website/sites/${site.id}`;
    await makeKey(base, "read");
    if (write) await makeKey(base, "write");

    const [agent] = await db.insert(agents)
      .values({ companyId, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: "website:view", scope: null });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    const agentActor = { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor;

    const person = async (role: "owner" | "admin" | "operator", source: "session" | "board_key" = "session") => {
      const userId = `user${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
      return { userId, actor: { type: "board", userId, source, isInstanceAdmin: false, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }] } as Actor };
    };
    const owner = await person("owner");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, identifier: "C-1", title: "Give Ed portal approval",
      status: "in_progress", priority: "medium", assigneeAgentId: agent!.id });
    return { companyId, siteId: site.id as string, base, agent: { actor: agentActor, agentId: agent!.id }, owner, person, issueId };
  }

  const writes = () => seen.filter((s) => s.method !== "GET");

  it("reads staff, portal approvers and a client's members for any actor with website:view, on the read key", async () => {
    const world = await seedWorld();
    const http = request(app(world.agent.actor));
    const staffRes = await http.get(`${world.base}/access/staff`).expect(200);
    expect(staffRes.body).toEqual({ items: staff, nextCursor: null });
    await http.get(`${world.base}/access/portal-approvers`).expect(200, { items: [], nextCursor: null });
    const membersRes = await http.get(`${world.base}/access/clients/${CLIENT}/members`).expect(200);
    expect(membersRes.body.items).toHaveLength(1);
    expect(seen.every((s) => s.verified && s.method === "GET" && s.headers["x-gs-bridge-key"]!.startsWith("stg-read-"))).toBe(true);
    expect(seen[0]!.headers["x-gs-bridge-actor"]).toBe(`agent:${world.agent.agentId}`);
    expect(seen[0]!.headers["x-gs-bridge-run"]).toBeDefined();

    // the site's 404, a bad id and a query never reach a list
    const calls = seen.length;
    await http.get(`${world.base}/access/clients/not-a-uuid/members`).expect(404);
    await http.get(`${world.base}/access/staff?limit=5`).expect(422);
    expect(seen).toHaveLength(calls);
    await http.get(`${world.base}/access/clients/${randomUUID()}/members`).expect(404);

    // an operator views by role; an agent without its website:view grant does not
    const { actor: operator } = await world.person("operator");
    await request(app(operator)).get(`${world.base}/access/staff`).expect(200);
    await db.delete(principalPermissionGrants);
    await request(app(world.agent.actor)).get(`${world.base}/access/staff`).expect(403);
  });

  it("refuses an agent and a board API key every change with 403 before any call to the site", async () => {
    const world = await seedWorld();
    const { actor: script } = await world.person("owner", "board_key");
    const changes = [
      ["patch", `access/staff/${EDITOR}`, { role: "admin" }],
      ["put", `access/portal-approvers/${EDITOR}`, { label: "Sales lead" }],
      ["delete", `access/portal-approvers/${EDITOR}`, undefined],
      ["post", `access/clients/${CLIENT}/members`, { email: "new@client.example.test", name: "New", role: "member" }],
      ["patch", `access/clients/${CLIENT}/members/${MEMBER}`, { role: "admin" }],
      ["delete", `access/clients/${CLIENT}/members/${MEMBER}`, undefined],
    ] as const;
    for (const actor of [world.agent.actor, script]) {
      for (const [method, p, body] of changes) {
        const refused = await request(app(actor))[method](`${world.base}/${p}`).send(body ?? {}).expect(403);
        expect(refused.body.code, `${method} ${p}`).toBe("website_access_people_only");
      }
    }
    // an operator is a person but has no Publish rights
    const { actor: operator } = await world.person("operator");
    const noRights = await request(app(operator)).patch(`${world.base}/access/staff/${EDITOR}`).send({ role: "admin" }).expect(403);
    expect(noRights.body.code).toBe("website_permission_missing");
    expect(seen).toHaveLength(0);
  });

  it("a person makes each of the six changes on the write key in their own name, and each is logged without emails", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    const ed = await http.patch(`${world.base}/access/staff/${EDITOR}`).send({ role: "admin" }).expect(200);
    expect(ed.body.item).toMatchObject({ id: EDITOR, role: "admin" });
    await http.put(`${world.base}/access/portal-approvers/${EDITOR}`).send({ label: "Sales lead" }).expect(200);
    expect(approvers).toEqual([expect.objectContaining({ staffId: EDITOR, label: "Sales lead" })]);
    await http.delete(`${world.base}/access/portal-approvers/${EDITOR}`).expect(200, { staffId: EDITOR, removed: true });
    const added = await http.post(`${world.base}/access/clients/${CLIENT}/members`)
      .send({ email: "New@Client.example.test", name: "Nia New", role: "admin" }).expect(200);
    expect(added.body.item).toMatchObject({ email: "new@client.example.test", role: "admin" });
    await http.patch(`${world.base}/access/clients/${CLIENT}/members/${MEMBER}`).send({ role: "admin" }).expect(200);
    await http.delete(`${world.base}/access/clients/${CLIENT}/members/${MEMBER}`).expect(200);
    expect(members.map((m) => m.email)).toEqual(["new@client.example.test"]);

    expect(writes().map((s) => `${s.method} ${s.path}`)).toEqual([
      `PATCH access/staff/${EDITOR}`, `PUT access/portal-approvers/${EDITOR}`, `DELETE access/portal-approvers/${EDITOR}`,
      `POST access/clients/${CLIENT}/members`, `PATCH access/clients/${CLIENT}/members/${MEMBER}`, `DELETE access/clients/${CLIENT}/members/${MEMBER}`,
    ]);
    for (const s of writes()) {
      expect(s.verified).toBe(true);
      expect(s.headers["x-gs-bridge-key"]).toMatch(/^stg-write-/);
      expect(s.headers["x-gs-bridge-actor"]).toBe(`user:${world.owner.userId}`);
    }
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.access_changed");
    expect(logged.map((e) => (e.details as { kind: string }).kind)).toEqual(
      ["staff_role", "approver_set", "approver_remove", "member_add", "member_role", "member_remove"]);
    expect(logged.every((e) => e.actorId === world.owner.userId)).toBe(true);
    expect(logged[3]!.details).toMatchObject({ customerId: CLIENT, role: "admin", membershipId: added.body.item.membershipId });
    expect(JSON.stringify(logged)).not.toMatch(/@/);
  });

  it("passes the site's refusals back: the last owner is 409, an unknown person 404, a bad body 422 with no call", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    const last = await http.patch(`${world.base}/access/staff/${OWNER}`).send({ role: "admin" }).expect(409);
    expect(last.body.code).toBe("website_bridge_conflict");
    await http.patch(`${world.base}/access/staff/${randomUUID()}`).send({ role: "admin" }).expect(404);
    await http.delete(`${world.base}/access/portal-approvers/${EDITOR}`).expect(404);
    const calls = seen.length;
    await http.patch(`${world.base}/access/staff/${EDITOR}`).send({ role: "god" }).expect(422);
    await http.put(`${world.base}/access/portal-approvers/${EDITOR}`).send({ label: "" }).expect(422);
    await http.post(`${world.base}/access/clients/${CLIENT}/members`).send({ email: "not-an-email", name: "x", role: "member" }).expect(422);
    await http.patch(`${world.base}/access/staff/${EDITOR}`).send({ role: "admin", staffId: OWNER }).expect(422);
    await http.patch(`${world.base}/access/staff/not-a-uuid`).send({ role: "admin" }).expect(404);
    expect(seen).toHaveLength(calls);
  });

  it("fails closed with no write key: 409 capability_not_configured, no call to the site and no card", async () => {
    const world = await seedWorld({ write: false });
    const res = await request(app(world.owner.actor)).patch(`${world.base}/access/staff/${EDITOR}`).send({ role: "admin" }).expect(409);
    expect(res.body).toMatchObject({ code: "capability_not_configured", error: "Access changes are off for this site: no write key is set up" });
    await request(app(world.agent.actor)).post(`${world.base}/access/change-requests`)
      .send({ change: { kind: "staff_role", staffId: EDITOR, role: "admin" } }).expect(409);
    expect(seen).toHaveLength(0);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  describe("an agent's ask (website_access_change)", () => {
    const ask = (world: Awaited<ReturnType<typeof seedWorld>>, change: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      request(app(world.agent.actor)).post(`${world.base}/access/change-requests`)
        .send({ change, note: "Ed runs sales now", issueId: world.issueId, ...extra });
    const makeApprover = { kind: "approver_set", staffId: EDITOR, label: "Sales lead" };

    it("opens one card on the agent's task with before and after, and changes nothing", async () => {
      const world = await seedWorld();
      const res = await ask(world, makeApprover).expect(201);
      expect(writes()).toHaveLength(0);
      expect(seen.every((s) => s.headers["x-gs-bridge-actor"] === `agent:${world.agent.agentId}`)).toBe(true);
      const cards = await db.select().from(approvals);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: res.body.approval.id, type: "website_access_change", status: "pending", requestedByAgentId: world.agent.agentId });
      expect(cards[0]!.payload).toMatchObject({
        siteId: world.siteId, change: makeApprover, requestedBy: "Lintel", note: "Ed runs sales now",
        title: "Add Ed Editor as portal approver", beforeText: "not a portal approver", afterText: 'portal approver: "Sales lead"',
        before: { staffId: EDITOR, approver: null },
      });
      expect((await db.select().from(issueApprovals)).map((l) => [l.issueId, l.approvalId])).toEqual([[world.issueId, cards[0]!.id]]);
      const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.access_change_requested");
      expect(logged).toHaveLength(1);

      // the same ask again is the same card
      expect((await ask(world, makeApprover).expect(200)).body.approval.id).toBe(cards[0]!.id);
      expect(await db.select().from(approvals)).toHaveLength(1);
      // nothing to change, no such person, a task in another company, and a hand-made card are refused
      const same = await ask(world, { kind: "staff_role", staffId: EDITOR, role: "editor" }).expect(422);
      expect(same.body.code).toBe("website_access_request_no_change");
      await ask(world, { kind: "staff_role", staffId: randomUUID(), role: "admin" }).expect(422);
      await ask(world, { kind: "staff_role", staffId: EDITOR, role: "admin" }, { issueId: randomUUID() }).expect(422);
      await request(app(world.owner.actor)).post(`/api/companies/${world.companyId}/approvals`)
        .send({ type: "website_access_change", payload: { siteId: world.siteId } }).expect(422);
      await request(app(world.agent.actor)).post(`/api/approvals/${cards[0]!.id}/resubmit`).send({}).expect(422);
      expect(writes()).toHaveLength(0);
    });

    it("only a signed-in person with Publish rights decides", async () => {
      const world = await seedWorld();
      const card = (await ask(world, makeApprover).expect(201)).body.approval;
      const approveAs = (actor: Actor) => request(app(actor)).post(`/api/approvals/${card.id}/approve`).send({});
      await approveAs(world.agent.actor).expect(403);
      await approveAs((await world.person("owner", "board_key")).actor).expect(403);
      expect((await approveAs((await world.person("operator")).actor).expect(403)).body.code).toBe("website_access_decider_missing");
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/request-revision`).send({ decisionNote: "x" }).expect(422);
      expect(writes()).toHaveLength(0);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending" });
    });

    it("approving makes the change once, in the approver's name, and logs who asked and who approved", async () => {
      const world = await seedWorld();
      const card = (await ask(world, makeApprover).expect(201)).body.approval;
      const approved = await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(approved.body).toMatchObject({ status: "approved", decidedByUserId: world.owner.userId,
        payload: { result: { item: { staffId: EDITOR, label: "Sales lead" } } } });
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ method: "PUT", path: `access/portal-approvers/${EDITOR}`, verified: true });
      expect(JSON.parse(writes()[0]!.body)).toEqual({ label: "Sales lead" });
      expect(writes()[0]!.headers["x-gs-bridge-actor"]).toBe(`user:${world.owner.userId}`);
      expect(approvers).toHaveLength(1);
      const changed = (await db.select().from(activityLog)).filter((e) => e.action === "website.access_changed");
      expect(changed).toEqual([expect.objectContaining({ actorType: "user", actorId: world.owner.userId,
        details: expect.objectContaining({ kind: "approver_set", staffId: EDITOR, approvalId: card.id, approvedByUserId: world.owner.userId,
          requestedByAgentId: world.agent.agentId }) })]);

      // a second click changes nothing on the site
      const calls = seen.length;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(seen).toHaveLength(calls);
    });

    it("a lost answer keeps the card open; the next click replays the same key and changes once", async () => {
      const world = await seedWorld();
      const card = (await ask(world, { kind: "staff_role", staffId: EDITOR, role: "admin" }).expect(201)).body.approval;
      lose = 3;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(502);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending", decidedByUserId: null });
      expect(staff[1]!.role).toBe("admin");
      lose = 0;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(new Set(writes().map((s) => s.headers["x-gs-bridge-idempotency-key"])).size).toBe(1);
      expect(writes().filter((s) => !s.replayed)).toHaveLength(1);
    });

    it("rejecting changes nothing, and the agent hears why on its task", async () => {
      const world = await seedWorld();
      const card = (await ask(world, makeApprover).expect(201)).body.approval;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/reject`).send({ decisionNote: "Not yet" }).expect(200);
      expect(writes()).toHaveLength(0);
      expect(approvers).toHaveLength(0);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, world.issueId));
      expect(comments.map((c) => c.body)).toEqual([expect.stringMatching(/Not approved: Add Ed Editor as portal approver\. Nothing was changed\. Reason: Not yet/)]);
      expect(wakeups).toEqual([expect.objectContaining({ agentId: world.agent.agentId,
        opts: expect.objectContaining({ reason: "approval_rejected", idempotencyKey: `website-access-change:${card.id}:rejected` }) })]);
    });

    it("a change to the person's access after the ask voids the card, and the site's refusal closes it", async () => {
      const world = await seedWorld();
      const card = (await ask(world, { kind: "member_role", customerId: CLIENT, membershipId: MEMBER, role: "admin" }).expect(201)).body.approval;
      Object.assign(members[0]!, { name: "Ann Renamed", updatedAt: stamp() });
      const voided = await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(409);
      expect(voided.body.code).toBe("website_access_request_void");
      expect(writes()).toHaveLength(0);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "cancelled" });
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, world.issueId));
      expect(comments[0]!.body).toMatch(/Ask again/);

      // the last owner: the site says 409 at approval, the card closes and nothing changes
      staff.push({ ...staff[0]!, id: randomUUID(), email: "o2@example.test", name: "Second Owner" });
      const demote = (await ask(world, { kind: "staff_role", staffId: OWNER, role: "admin" }).expect(201)).body.approval;
      staff.pop();
      await db.update(approvals).set({ payload: { ...(await db.select().from(approvals).where(eq(approvals.id, demote.id)))[0]!.payload as object,
        sentAt: new Date().toISOString() } }).where(eq(approvals.id, demote.id));
      await request(app(world.owner.actor)).post(`/api/approvals/${demote.id}/approve`).send({}).expect(409);
      expect((await db.select().from(approvals).where(eq(approvals.id, demote.id)))[0]).toMatchObject({ status: "cancelled" });
      expect(staff[0]!.role).toBe("owner");
    });
  });
});
