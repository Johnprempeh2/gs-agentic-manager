import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  issues,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import { HANDOFF_SOURCE_KIND, parseHandoffMarkdown, renderHandoffMarkdown, type HandoffReadResult, type HandoffWriteResult } from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import { memoryToolRoutes } from "../routes/memory-tools.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { HANDOFF_RETAIN_DELAY_MS, personHandoffSummary, readOwnerFocus } from "../services/memory-gateway/handoff.js";
import { memoryToolDefinitions } from "../services/memory-tools.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/** Hindsight that answers, or one that is down (every call fails). */
function engine(state: { up: boolean }) {
  const retained: string[] = [];
  const fail = () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8888"), { code: "ECONNREFUSED" });
  };
  const value: MemoryEngine = {
    async retain(doc) {
      if (!state.up) fail();
      retained.push(doc.documentId);
    },
    async recall() {
      if (!state.up) fail();
      return [];
    },
    async deleteDocument() {
      if (!state.up) fail();
    },
  };
  return { engine: value, retained };
}

describe("handoff tools are offered to every caller (GRE-2668)", () => {
  it("lists handoff_read and handoff_update for GSAM agents and for outside apps", () => {
    for (const externalApp of [false, true]) {
      const names = memoryToolDefinitions({ externalApp }).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["handoff_read", "handoff_update"]));
    }
  });
});

describeEmbeddedPostgres("the live handoff in the shared bank (GRE-2668)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-handoff-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryIngestOutbox);
      await db.delete(memoryOperations);
      await db.delete(memoryReviewEvents);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(authUsers);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string, metadata: Record<string, unknown> | null = null) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status: metadata ? "paused" : "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, metadata })
      .returning();
    return agent;
  }

  let rpcId = 0;
  async function tool<T>(app: ReturnType<typeof routeApp>, name: string, args: Record<string, unknown>) {
    const res = await request(app).post("/api/mcp/memory-tools").send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return res.body.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent: T };
  }

  async function setup(name: string, hindsight = { up: true }) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const now = new Date();
    await ctx.db.insert(authUsers).values({ id: seeded.userId, name: "John Prempeh", email: `${seeded.userId}@example.test`, createdAt: now, updatedAt: now });
    await ctx.db.insert(memorySettings).values({ companyId: seeded.companyId, enabled: true });
    const fake = engine(hindsight);
    const rest = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine, engineTimeoutMs: 200 });
    const tools = (db: typeof ctx.db) => memoryToolRoutes(db, { engine: fake.engine, engineTimeoutMs: 200 });
    const keyActor = (agentId: string) =>
      ({ type: "agent", agentId, companyId: seeded.companyId, runId: null, source: "agent_key", keyScope: { kind: "memory_only" } }) as never;
    const links = {} as Record<"claude_code" | "codex", { rest: ReturnType<typeof routeApp>; tools: ReturnType<typeof routeApp> }>;
    for (const app of ["claude_code", "codex"] as const) {
      const agent = await seedAgent(seeded.companyId, `John's ${app}`, { memoryConnection: { app, createdByUserId: seeded.userId } });
      await ctx.db.insert(principalPermissionGrants).values({ companyId: seeded.companyId, principalType: "agent", principalId: agent.id, permissionKey: "memory:contribute", scope: null });
      links[app] = { rest: routeApp(ctx.db, keyActor(agent.id), rest), tools: routeApp(ctx.db, keyActor(agent.id), tools) };
    }
    const base = `/api/companies/${seeded.companyId}/memory`;
    return { ...seeded, fake, rest, tools, links, base, hindsight };
  }

  async function everestRun(companyId: string, tools: (db: typeof ctx.db) => ReturnType<typeof memoryToolRoutes>) {
    const agent = await seedAgent(companyId, "Everest");
    const [task] = await ctx.db.insert(issues).values({ companyId, title: "Daily status", status: "in_progress", priority: "medium" }).returning();
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", contextSnapshot: { issueId: task.id } }).returning();
    return { agent, app: routeApp(ctx.db, { type: "agent", source: "agent_jwt", agentId: agent.id, companyId, runId: run.id } as never, tools) };
  }

  const handoffRows = async () => (await ctx.db.select().from(memoryRecords)).filter((row) => row.sourceKind === HANDOFF_SOURCE_KIND);

  it("an update from Codex reads back in Claude as by ChatGPT, with what changed since Claude last wrote", async () => {
    const { links } = await setup("ByChatGPT");
    const fromClaude = await tool<HandoffWriteResult>(links.claude_code.tools, "handoff_update", {
      doing: "starting the handoff work",
      focus: "Ship the shared memory before Indago.",
      threads: [{ ref: "GRE-2668", title: "Hindsight shared memory", state: "building", next: "add the handoff" }],
    });
    expect(fromClaude.isError).toBeFalsy();
    expect(fromClaude.structuredContent).toMatchObject({ bankName: "greatstone-john", revision: 1, changed: true });

    const fromCodex = await tool<HandoffWriteResult>(links.codex.tools, "handoff_update", {
      doing: "answering Keystone's review",
      threads: [{ ref: "GRE-2668", state: "changes requested", next: "add handoff_read and handoff_update" }],
      waiting: ["Approve the release card (GRE-2695)"],
    });
    expect(fromCodex.structuredContent.revision).toBe(2);

    const read = await tool<HandoffReadResult>(links.claude_code.tools, "handoff_read", { since: "my_last_update" });
    const handoff = read.structuredContent.handoff;
    expect(handoff.threads).toEqual([expect.objectContaining({ key: "GRE-2668", state: "changes requested", title: "Hindsight shared memory", by: { tool: "chatgpt", label: "ChatGPT" } })]);
    // Claude's own line is still Claude's: two tools never overwrite each other's parts.
    expect(handoff.focus).toMatchObject({ text: "Ship the shared memory before Indago.", by: { label: "Claude" } });
    expect(handoff.lastTool).toMatchObject({ by: { label: "ChatGPT" }, doing: "answering Keystone's review" });
    expect(read.structuredContent.markdown).toContain("<!-- by ChatGPT · ");
    expect(read.structuredContent.markdown).toContain("- GRE-2668 Hindsight shared memory | state: changes requested | next: add handoff_read and handoff_update");
    // What changed since Claude left: only Codex's changes.
    const since = read.structuredContent.changesSince!;
    expect(since.versions).toBe(1);
    expect(since.changes.map((change) => [change.unit, change.by.label])).toEqual([
      ["waiting", "ChatGPT"],
      ["thread:GRE-2668", "ChatGPT"],
    ]);

    // Every update is its own version; the old ones are kept as history.
    const rows = await handoffRows();
    expect(rows.map((row) => [row.version, row.status]).sort()).toEqual([[1, "superseded"], [2, "unreviewed"]]);
    // The same update again changes nothing and makes no version.
    const again = await tool<HandoffWriteResult>(links.codex.tools, "handoff_update", { doing: "answering Keystone's review", waiting: ["Approve the release card (GRE-2695)"] });
    expect(again.structuredContent).toMatchObject({ changed: false, revision: 2 });
    expect(await handoffRows()).toHaveLength(2);
  });

  it("keeps both tools' lines when they write at the same moment", async () => {
    const { links } = await setup("Concurrent");
    await Promise.all([
      tool(links.claude_code.tools, "handoff_update", { doing: "focus", focus: "Release prep." }),
      tool(links.codex.tools, "handoff_update", { doing: "threads", threads: [{ ref: "GRE-571", title: "Taxi prototype scope", state: "waiting" }] }),
    ]);
    const read = await tool<HandoffReadResult>(links.claude_code.tools, "handoff_read", {});
    expect(read.structuredContent.handoff.focus?.text).toBe("Release prep.");
    expect(read.structuredContent.handoff.threads.map((thread) => thread.key)).toEqual(["GRE-571"]);
    expect(read.structuredContent.revision).toBe(2);
  });

  it("keeps working while Hindsight is down, and sends only the newest version once it is back", async () => {
    const hindsight = { up: false };
    const { links, fake } = await setup("HindsightDown", hindsight);
    const first = await tool<HandoffWriteResult>(links.codex.tools, "handoff_update", { doing: "working offline", focus: "Indago call first." });
    expect(first.isError).toBeFalsy();
    const second = await tool<HandoffWriteResult>(links.codex.tools, "handoff_update", { doing: "still offline", threads: [{ ref: "GRE-2668", title: "Shared memory", state: "in review" }] });
    expect(second.isError).toBeFalsy();
    const read = await tool<HandoffReadResult>(links.claude_code.tools, "handoff_read", {});
    expect(read.structuredContent).toMatchObject({ revision: 2, handoff: { focus: { text: "Indago call first.", by: { label: "ChatGPT" } } } });
    expect(fake.retained).toHaveLength(0);

    // One retain is waiting, held a few minutes; the older version's will never be sent.
    const outbox = await ctx.db.select().from(memoryIngestOutbox);
    const rows = await handoffRows();
    const live = rows.find((row) => row.status === "unreviewed")!;
    const pending = outbox.filter((entry) => entry.state === "pending");
    expect(pending.map((entry) => entry.recordId)).toEqual([live.id]);
    expect(pending[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(live.createdAt.getTime() + HANDOFF_RETAIN_DELAY_MS - 1_000);
    expect(outbox.filter((entry) => entry.state === "cancelled")).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ bankId: "greatstone-john" });
    expect(String((pending[0].payload as { content: string }).content)).toContain("Last tool: ChatGPT");
  });

  it("merges NOW.md edits made while GSAM was down, newest wins per section, and records the clash", async () => {
    const { links, base } = await setup("NowMd");
    const v1 = await tool<HandoffWriteResult>(links.claude_code.tools, "handoff_update", {
      doing: "before the outage",
      focus: "Release prep.",
      threads: [
        { ref: "GRE-2668", title: "Shared memory", state: "in review", next: "Flint" },
        { ref: "GRE-571", title: "Taxi prototype", state: "waiting", next: "sign-off" },
      ],
    });
    const fileAtV1 = v1.structuredContent.markdown;

    // The Mac wrote revision 1 to NOW.md. GSAM goes on: Claude changes the focus at 10:00.
    await tool(links.claude_code.tools, "handoff_update", { doing: "online", focus: "Release tonight." });
    // Offline, Codex edited NOW.md at 11:00: the focus (with its by line) and the GRE-571 thread.
    const offlineEdit = fileAtV1
      .replace(/<!-- by Claude · [^>]+ -->\nRelease prep\./, `<!-- by ChatGPT · ${new Date(Date.now() + 30_000).toISOString()} -->\nIndago call first.`)
      .replace("state: waiting | next: sign-off", "state: discovery booked | next: send the brief");
    const res = await request(links.claude_code.rest)
      .post(`${base}/handoff/file`)
      .send({ text: offlineEdit, fileChangedAt: new Date(Date.now() + 40_000).toISOString(), baseRevision: 1 });
    expect(res.status).toBe(200);
    const merged = res.body as HandoffWriteResult;
    expect(merged.revision).toBe(3);
    expect(merged.handoff.focus).toMatchObject({ text: "Indago call first.", by: { label: "ChatGPT" } });
    expect(merged.handoff.threads.find((thread) => thread.key === "GRE-571")).toMatchObject({ state: "discovery booked", next: "send the brief", by: { tool: "now_md" } });
    // GSAM's untouched thread is as it was.
    expect(merged.handoff.threads.find((thread) => thread.key === "GRE-2668")).toMatchObject({ state: "in review", by: { label: "Claude" } });
    // The clash on the focus is recorded on the version.
    expect(merged.conflicts).toEqual([expect.objectContaining({ unit: "focus", kept: "file", lostValue: "Release tonight.", lostBy: expect.objectContaining({ label: "Claude" }) })]);
    const live = (await handoffRows()).find((row) => row.version === 3)!;
    expect((live.evidence as { conflicts: unknown[] }).conflicts).toHaveLength(1);

    // The Mac writes GSAM's answer back; sending that same file again changes nothing.
    const again = await request(links.claude_code.rest).post(`${base}/handoff/file`).send({ text: merged.markdown, fileChangedAt: new Date().toISOString(), baseRevision: 3 });
    expect(again.body).toMatchObject({ changed: false, revision: 3 });
    // An empty file never wipes the handoff.
    const empty = await request(links.claude_code.rest).post(`${base}/handoff/file`).send({ text: "  \n", fileChangedAt: new Date().toISOString(), baseRevision: 3 });
    expect(empty.body).toMatchObject({ changed: false, revision: 3 });
    // The file GSAM writes reads back to the same handoff.
    expect(parseHandoffMarkdown(merged.markdown).revision).toBe(3);
    expect(renderHandoffMarkdown(merged.handoff, { personName: "John", bankName: "greatstone-john", revision: 3, writtenAt: merged.updatedAt! })).toBe(merged.markdown);
  });

  it("brings an old free-form NOW.md in as notes on the first sync", async () => {
    const { links, base } = await setup("FirstSync");
    const res = await request(links.claude_code.rest)
      .post(`${base}/handoff/file`)
      .send({ text: "# NOW\n\nIndago kick-off first.\n\n## Next session\n- call Ben\n", fileChangedAt: new Date().toISOString(), baseRevision: 0 });
    expect(res.status).toBe(200);
    expect(res.body.handoff.notes.text).toBe("Indago kick-off first.\n\n### Next session\n- call Ben");
    expect(res.body.markdown).toContain("## Notes");
  });

  it("lets GSAM agents read John's handoff and update threads and the waiting list, never the focus", async () => {
    const { links, companyId, tools, base, rest } = await setup("Agents");
    await tool(links.claude_code.tools, "handoff_update", { doing: "planning", focus: "Indago before shared memory." });
    const everest = await everestRun(companyId, tools);

    const read = await tool<HandoffReadResult>(everest.app, "handoff_read", {});
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ bankName: "greatstone-john", handoff: { focus: { text: "Indago before shared memory." } } });
    const byName = await tool<HandoffReadResult>(everest.app, "handoff_read", { person: "greatstone-john" });
    expect(byName.structuredContent.revision).toBe(1);

    const update = await tool<HandoffWriteResult>(everest.app, "handoff_update", {
      doing: "daily status",
      threads: [{ ref: "GRE-2695", title: "Release card", state: "ready", next: "John runs the release" }],
      waiting: ["Run the release (GRE-2695)"],
    });
    expect(update.isError).toBeFalsy();
    expect(update.structuredContent.handoff.threads[0].by).toMatchObject({ tool: "gsam_agent", label: "GSAM agent Everest" });

    const focus = await tool(everest.app, "handoff_update", { doing: "trying", focus: "Something else" });
    expect(focus.isError).toBe(true);
    expect(focus.content[0].text).toMatch(/Only John/);

    // Without a live run (a plain agent key), an agent cannot write it.
    const keyOnly = routeApp(ctx.db, { type: "agent", agentId: everest.agent.id, companyId, runId: null, source: "agent_key" } as never, rest);
    expect((await request(keyOnly).post(`${base}/handoff`).send({ doing: "x", waiting: ["y"] })).status).toBe(404);
    // The NOW.md route is for the person's own apps only.
    expect((await request(keyOnly).post(`${base}/handoff/file`).send({ text: "# NOW", fileChangedAt: new Date().toISOString(), baseRevision: 0 })).status).toBe(403);
  });

  it("keeps another person's apps out of John's handoff, and refuses what looks like a secret", async () => {
    const { links, companyId, rest, base } = await setup("Others");
    await tool(links.claude_code.tools, "handoff_update", { doing: "planning", focus: "Private focus." });
    await ctx.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "user-ben", status: "active", membershipRole: "operator", updatedAt: new Date() });
    const bens = await seedAgent(companyId, "Ben's codex", { memoryConnection: { app: "codex", createdByUserId: "user-ben" } });
    const asBen = routeApp(ctx.db, { type: "agent", agentId: bens.id, companyId, runId: null, source: "agent_key", keyScope: { kind: "memory_only" } } as never, rest);
    expect((await request(asBen).get(`${base}/handoff`).query({ person: "greatstone-john" })).status).toBe(404);

    const secret = await tool(links.codex.tools, "handoff_update", { doing: "oops", notes: `key sk-ant-api03-${"aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC".repeat(2)}` });
    expect(secret.isError).toBe(true);
    expect(secret.content[0].text).toMatch(/Not stored/);
    expect(await handoffRows()).toHaveLength(1);
  });

  it("gives agents John's focus in the wake, and John's digest where he left off", async () => {
    const { links, companyId, userId } = await setup("Digest");
    expect(await readOwnerFocus(ctx.db, companyId)).toBeNull();
    const before = new Date(Date.now() - 1_000);
    await tool(links.codex.tools, "handoff_update", {
      doing: "wrapping up",
      focus: "Indago kick-off on 9 Nov.",
      threads: [{ ref: "GRE-2668", title: "Shared memory", state: "in review", next: "Flint" }],
      waiting: ["Approve the release card"],
    });
    expect(await readOwnerFocus(ctx.db, companyId)).toMatchObject({ personName: "John", text: "Indago kick-off on 9 Nov.", by: "ChatGPT" });
    const digest = await personHandoffSummary(ctx.db, companyId, userId, before);
    expect(digest).toMatchObject({
      focus: { text: "Indago kick-off on 9 Nov.", by: "ChatGPT" },
      threadCount: 1,
      threads: [expect.objectContaining({ refs: ["GRE-2668"], state: "in review", by: "ChatGPT" })],
      waiting: "- Approve the release card",
      lastTool: expect.objectContaining({ by: "ChatGPT", doing: "wrapping up" }),
      changesSince: 3,
    });
    expect(await personHandoffSummary(ctx.db, companyId, "user-nobody", before)).toBeNull();
  });
});
