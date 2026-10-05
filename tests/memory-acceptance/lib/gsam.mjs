// GSAM target: the real memory gateway (GRE-672, `server/src/routes/memory.ts`)
// in a sandbox GSAM server, with a sandbox Hindsight engine (GRE-674 runbook,
// "Sandbox test"). Never the live app: the runner refuses port 3100 and the
// live embedded database on 54329.
//
// The fixtures speak in Kestrel Works names (cl-alder, ag-lintel-syn, R-301).
// The gateway speaks in UUIDs. This target provisions a fresh synthetic
// company on every run and translates both ways:
//
// - Board calls (company, projects, scopes, agents, keys) go through the API
//   with no credential, so the sandbox must run in `local_trusted` mode. The
//   board stands in for hu-john-syn.
// - Memory grants and heartbeat runs have no API yet, so they are written to
//   the sandbox database, the same way the gateway's own route tests do.
// - Audit evidence is the gateway's `memory_operations` table, read back from
//   the sandbox database.
// - Admin read-back of the engine (MT-07, MT-09, MT-12) uses the sandbox
//   engine's superuser socket. The shared engine's key never enters a run.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createLiveTarget } from "./live.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Stands in for a scope id that does not exist (MT-02 "not found" twin). */
export const MISSING_SCOPE_ID = "00000000-0000-4000-8000-00000000d0e5";
/** Stands in for a fixture record this run never created. */
export const MISSING_RECORD_ID = "00000000-0000-4000-8000-00000000ec0d";

const LIVE_APP_PORTS = new Set(["3100"]);
const LIVE_DB_PORTS = new Set(["54329"]);

export function loadGsamConfig(path) {
  if (!path || !existsSync(path)) throw new Error(`GSAM config not found: ${path ?? "(unset)"} (set MEMORY_ACCEPTANCE_GSAM_CONFIG)`);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const gateway = new URL(cfg.gatewayUrl);
  if (LIVE_APP_PORTS.has(gateway.port)) throw new Error("Refusing to run against port 3100 (the live app). Use a sandbox server.");
  const db = new URL(cfg.databaseUrl);
  if (LIVE_DB_PORTS.has(db.port)) throw new Error("Refusing to use database port 54329 (the live app's database). Use the sandbox database.");
  return {
    retainMode: "chunks",
    timeoutMs: 10_000,
    approvePermissionKey: "memory:approve",
    ...cfg,
    routes: { ...PHASE2_ROUTES, ...PHASE3_ROUTES, ...(cfg.routes ?? {}) },
    engine: { host: "127.0.0.1", restPort: 28888, controlPlanePort: 9999, postgresPort: 25432, ...(cfg.engine ?? {}) },
  };
}

/**
 * Phase 2 gateway routes (GRE-886 `routes/memory.ts`, GRE-887
 * `routes/memory-steward.ts`), relative to /api/companies/:companyId/memory.
 * Override any of them with `routes` in the config file. A route that answers
 * "API route not found" makes its test inconclusive.
 */
export const PHASE2_ROUTES = {
  review: "POST /records/:id/review", // { action: "approve" | "dispute", reason }
  supersede: "POST /records/:id/supersede", // { replacementRecordId, reason }
  remove: "POST /records/:id/delete", // { reason }
  history: "GET /records/:id/history", // { record, chain, events, extractedFacts }
  relationships: "GET /records/:id/relationships",
  conflicts: "GET /conflicts", // { note, groups: [{ scope, approvedPosition, conflicts }] }
  directive: "POST /directives", // no such route: directives do not exist in the gateway
  stewardGrant: "POST /steward/grants", // sandbox only (GSAM_MEMORY_STEWARD_SANDBOX_GRANTS=true)
  stewardRun: "POST /steward/review",
  stewardQueue: "GET /steward/queue",
  stewardReport: "GET /steward/report?days=7",
};

/**
 * Phase 3 routes (GRE-864 `routes/memory.ts`, types in `packages/shared/src/memory.ts`).
 * There is no separate list route: the list view is built from the graph.
 * Activity and counts take `to` as exclusive; the runner's ranges are inclusive dates.
 */
export const PHASE3_ROUTES = {
  relationshipCreate: "POST /relationships", // GRE-886 { fromRecordId, toRecordId, type, note, sourceKind, sourceId }
  graph: "GET /graph",
  node: "GET /graph/nodes/:id",
  edge: "GET /graph/edges/:id",
  activity: "GET /activity",
  counts: "GET /activity/counts",
};

/** Phase 2 review-event actions, by the double's event names the runner backdates. */
const EVENT_ACTIONS = { approved: "approve", disputed: "dispute", superseded_by: "superseded_by", supersede: "supersede", contributed: "contribute" };

/** Diagnostic only (--prime-org): makes the company bank exist before the tests. */
const PRIME_ORG_TEXT = "Kestrel Works office hours are 09:00 to 17:30 on weekdays (synthetic prime record).";

export function createGsamTarget(cfg, { world, primeOrg = false }) {
  const base = cfg.gatewayUrl.replace(/\/$/, "");
  const state = {
    companyId: null,
    scopeIds: {}, // fixture scope -> uuid
    bankIds: {}, // fixture scope -> engine bank id
    agentIds: {}, // fixture identity -> uuid
    tokens: {}, // fixture identity -> sandbox agent key (memory only, never written)
    runIds: {}, // fixture run -> uuid
    names: new Map(), // uuid -> fixture name
    records: new Map(), // record uuid -> fixture record id
    byFixture: new Map(), // fixture record id -> latest record uuid
  };

  // ---- plumbing ----------------------------------------------------------

  async function http(path, { method = "GET", headers = {}, body } = {}) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      return { status: 0, body: { error: "unreachable", message: String(err?.cause?.code ?? err?.message ?? err) } };
    }
  }

  async function board(path, opts) {
    const res = await http(path, opts);
    if (res.status === 0 || res.status >= 300) throw new Error(`Board ${opts?.method ?? "GET"} ${path} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  }

  async function sql(query, url = cfg.databaseUrl) {
    const { stdout } = await execFileAsync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

  /** Every uuid the target created becomes its fixture name, so a leaked id reads as a leaked name. */
  function toFixtureNames(value) {
    // The local board acts as "local-board"; it is hu-john-syn in the fixtures.
    const s = JSON.stringify(value ?? null)
      .replace(UUID_RE, (id) => state.names.get(id.toLowerCase()) ?? id)
      .replace(/"local-board"/g, '"hu-john-syn"');
    return JSON.parse(s);
  }

  function name(id, kind) {
    state.names.set(id.toLowerCase(), kind);
  }

  function remember(recordId, fixtureId) {
    state.records.set(recordId, fixtureId);
    state.byFixture.set(fixtureId, recordId);
    name(recordId, fixtureId);
  }

  function recordIdFor(fixtureId) {
    return state.byFixture.get(fixtureId) ?? MISSING_RECORD_ID;
  }

  /** Calls a phase 2 route from cfg.routes ("METHOD /path/:id"). */
  async function route(key, { id, headers = {}, body } = {}) {
    const [method, path] = cfg.routes[key].split(" ");
    return http(`/api/companies/${state.companyId}/memory${path.replace(":id", id ?? "")}`, { method, headers, body });
  }

  /** A phase 3 read with filters as query parameters (fixture names mapped to ids, inclusive dates to the gateway's exclusive `to`). */
  async function phase3View(key, headers, f = {}) {
    const q = new URLSearchParams();
    if (f.agent === "hu-john-syn") q.set("userId", "local-board");
    else if (f.agent) q.set("agentId", state.agentIds[f.agent] ?? MISSING_RECORD_ID);
    if (f.scope) q.set("scopeId", state.scopeIds[f.scope] ?? MISSING_SCOPE_ID);
    if (f.from) q.set("from", `${f.from}T00:00:00.000Z`);
    if (f.to) q.set("to", new Date(Date.parse(`${f.to}T00:00:00.000Z`) + 86_400_000).toISOString());
    for (const k of ["status", "q", "limit", "cursor"]) if (f[k]) q.set(k, String(f[k]));
    const [method, path] = cfg.routes[key].split(" ");
    return translateResult(await http(`/api/companies/${state.companyId}/memory${path}?${q}`, { method, headers: mapHeaders(headers) }));
  }

  /** Fixture name of a person, agent or check (`MemoryActorRef`, after the uuid rename). */
  function p3Actor(ref) {
    if (!ref || typeof ref === "string") return ref ?? null;
    if (ref.actorType === "system") return "system";
    return ref.agentId ?? ref.userId ?? ref.actorId ?? null;
  }

  function p3Node(n) {
    return { id: n.id, label: n.title ?? n.excerpt, scope: n.scopeId, status: n.status, contributor: p3Actor(n.contributor), source: n.source, createdAt: n.createdAt };
  }

  function p3Edge(e) {
    return { id: e.id, from: e.from, to: e.to, kind: e.kind, type: e.type, origin: e.origin, author: p3Actor(e.author), source: e.source };
  }

  function p3Activity(it) {
    const r = it.record ?? {};
    return {
      recordId: r.id,
      nodeId: r.id,
      contributor: p3Actor(it.contributor),
      at: r.createdAt,
      scope: r.scopeId,
      title: r.title,
      origin: it.source,
      source: it.source,
      status: r.status,
      history: (it.history ?? []).map((e) => ({ action: e.action, actor: e.agentId ?? e.userId ?? e.actorId, at: e.createdAt, related: e.relatedRecordId })),
    };
  }

  /** `rel:E-901` back to `rel:<uuid>`; an unknown name to an id that cannot exist. */
  function edgeIdFor(edgeId) {
    const back = String(edgeId).replace(/\b[ERX]-\d{3}\b/g, (n) => [...state.names].find(([, v]) => v === n)?.[0] ?? n);
    return back.includes(":") ? back : `rel:${MISSING_RECORD_ID}`;
  }

  function isRouteMissing(res) {
    return res.status === 404 && res.body?.error === "API route not found";
  }

  function listOf(body) {
    if (Array.isArray(body)) return body;
    return body?.items ?? body?.events ?? body?.relationships ?? body?.reviews ?? body?.runs ?? [];
  }

  // ---- provisioning ------------------------------------------------------

  async function provision() {
    const health = await http("/api/health");
    if (health.status !== 200) throw new Error(`Sandbox gateway not healthy: ${health.status}`);
    if (health.body?.deploymentMode && health.body.deploymentMode !== "local_trusted") {
      throw new Error(`Sandbox must run in local_trusted mode (got ${health.body.deploymentMode})`);
    }

    const company = await board("/api/companies", { method: "POST", body: { name: `${world.company.name} (synthetic ${new Date().toISOString()})` } });
    state.companyId = company.id;
    name(company.id, world.company.id);
    const c = `/api/companies/${company.id}`;
    await board(`${c}/memory/settings`, { method: "PATCH", body: { enabled: true, retainMode: cfg.retainMode } });

    // Scopes: org exists on first use; the rest are created by the board.
    const listed = await board(`${c}/memory/scopes`);
    for (const s of world.scopes) {
      let id;
      if (s.kind === "organization") {
        id = listed.find((x) => x.kind === "organization")?.id;
      } else {
        let projectId = null;
        if (s.kind === "project" || s.kind === "restricted_project") {
          const project = await board(`${c}/projects`, { method: "POST", body: { name: `${s.name} (synthetic)` } });
          projectId = project.id;
          name(project.id, `project:${s.id}`);
        }
        const created = await board(`${c}/memory/scopes`, { method: "POST", body: { kind: s.kind, name: s.name ?? s.id, projectId } });
        id = created.id;
      }
      if (!id) throw new Error(`Could not provision scope ${s.id}`);
      state.scopeIds[s.id] = id;
      name(id, s.id);
    }
    const banks = await sql(`select id, bank_id from memory_scopes where company_id = ${lit(company.id)}`);
    for (const line of banks.split("\n").filter(Boolean)) {
      const [id, bank] = line.split("|");
      const fixture = state.names.get(id);
      if (fixture) state.bankIds[fixture] = bank;
    }

    // Agents and their keys. hu-john-syn is the board.
    name("local-board", "hu-john-syn");
    for (const ident of world.identities) {
      if (!ident.id.startsWith("ag-")) continue;
      const agent = await board(`${c}/agents`, {
        method: "POST",
        body: { name: `${ident.id} (synthetic)`, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } },
      });
      state.agentIds[ident.id] = agent.id;
      name(agent.id, ident.id);
      const key = await board(`/api/agents/${agent.id}/keys`, { method: "POST", body: { name: "memory-acceptance" } });
      state.tokens[ident.id] = key.token;

      // Grants: one row per permission, listing exactly the fixture scopes.
      // Scoped `administer` has no gateway equivalent (memory:admin is
      // company-wide), so it is not granted; see grantNotes.
      for (const [right, key] of [["read", "memory:read"], ["contribute", "memory:contribute"], ["approve", cfg.approvePermissionKey]]) {
        const scopes = ident.grants.filter((g) => g.rights.includes(right)).map((g) => state.scopeIds[g.scope]);
        if (scopes.length === 0) continue;
        await sql(
          `insert into principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope)
           values (${lit(company.id)}, 'agent', ${lit(agent.id)}, ${lit(key)}, ${lit(JSON.stringify({ memoryScopeIds: scopes }))}::jsonb)`,
        );
      }

      // Runs: live ones are running, the rest finished.
      for (const run of ident.runs ?? []) {
        const id = randomUUID();
        const status = run.live ? "running" : "succeeded";
        const finished = run.live ? "null" : "now() - interval '1 hour'";
        await sql(
          `insert into heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at)
           values (${lit(id)}, ${lit(company.id)}, ${lit(agent.id)}, ${lit(status)}, now() - interval '2 hours', ${finished})`,
        );
        state.runIds[run.id] = id;
        name(id, run.id);
      }

      // The steward's review grant is the sandbox grant API (GRE-887 item 4), on the scopes it may read.
      if (ident.role === "steward") {
        const scopeIds = ident.grants.filter((g) => g.rights.includes("read")).map((g) => state.scopeIds[g.scope]);
        const res = await route("stewardGrant", { body: { agentId: agent.id, scopeIds, expiresInDays: 1, reason: "GRE-888 acceptance run (synthetic)" } });
        state.stewardGrant = res.status < 300 ? "granted" : `not granted: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`;
      }
    }
  }

  const grantNotes = world.identities
    .filter((i) => i.id.startsWith("ag-"))
    .flatMap((i) => i.grants.filter((g) => g.rights.includes("administer")).map((g) => `${i.id} administer ${g.scope}`))
    .join(", ");

  // ---- request translation ----------------------------------------------

  function mapHeaders(headers) {
    const h = { ...headers };
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === "x-paperclip-run-id" && state.runIds[h[k]]) h[k] = state.runIds[h[k]];
    }
    return h;
  }

  function scopeIdFor(fixtureScope) {
    return state.scopeIds[fixtureScope] ?? MISSING_SCOPE_ID;
  }

  function translateResult(res) {
    const body = toFixtureNames(res.body);
    if (Array.isArray(body?.results)) {
      // Seeded record ids are already fixture ids (R-302) after the rename.
      body.results = body.results.map((hit) => ({
        id: hit.record?.id,
        status: hit.record?.status,
        text: hit.record?.content,
        scope: hit.record?.scopeId,
        contributor: hit.record?.contributorAgentId ?? hit.record?.contributorUserId,
        hit,
      }));
    }
    if (body?.record) body.contributor = body.record.contributorAgentId ?? body.record.contributorUserId;
    return { status: res.status, body };
  }

  async function visibleScopeIds(headers) {
    const res = await http(`/api/companies/${state.companyId}/memory/scopes`, { headers: mapHeaders(headers) });
    return Array.isArray(res.body) ? res.body.map((s) => s.id) : [];
  }

  // ---- engine admin (sandbox only) ---------------------------------------

  const engineAdmin = cfg.engineAdmin; // { psql, socketDir, port, database }
  async function engineSql(query) {
    if (!engineAdmin) return null;
    const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-h", engineAdmin.socketDir, "-p", String(engineAdmin.port), "-d", engineAdmin.database, "-c", query];
    const { stdout } = await execFileAsync(engineAdmin.psql ?? "psql", args, { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...(engineAdmin.env ?? {}) } });
    return stdout.trim();
  }

  // Engine probes are the live target's, pointed at the sandbox engine and
  // the real bank ids the gateway made.
  let probes = null;

  return {
    name: "gsam",
    faults: [],
    allowedEgressHosts: ["anthropic"],
    state,
    async preflight() {
      await provision();
      probes = createLiveTarget({ ...cfg, routes: {}, identities: {}, bankIds: state.bankIds });
      // The gateway has no health route. The engine's own /health answers
      // without a key on loopback; seeding then proves the gateway reaches it.
      let engineUp = false;
      let engineNote = "";
      try {
        const r = await fetch(`http://${cfg.engine.host}:${cfg.engine.restPort}/health`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
        engineUp = r.status === 200;
        engineNote = `engine /health ${r.status}`;
      } catch (err) {
        engineNote = `engine /health unreachable: ${err?.cause?.code ?? err?.message}`;
      }
      return {
        ok: true,
        engineUp,
        notes: [
          `gateway ${base}, synthetic company ${state.companyId}`,
          engineNote,
          `scopes: ${Object.entries(state.scopeIds).map(([k, v]) => `${k}=${v}`).join(", ")}`,
          `grants not mapped (no gateway equivalent): ${grantNotes || "none"}`,
          `steward review grant: ${state.stewardGrant ?? "no steward identity"}`,
          ...(primeOrg ? ["DIAGNOSTIC: --prime-org seeded one extra synthetic org record (PRIME-ORG); not an acceptance run"] : []),
        ],
      };
    },
    async seed(fixtureItems) {
      const items = primeOrg ? [{ id: "PRIME-ORG", scope: "org", text: PRIME_ORG_TEXT }, ...fixtureItems] : fixtureItems;
      // ag-scribe-syn writes the seed, so John can approve it later without approving his own entry.
      for (const r of items) {
        const res = await http(`/api/companies/${state.companyId}/memory/records`, {
          method: "POST",
          headers: { Authorization: `Bearer ${state.tokens["ag-scribe-syn"]}` },
          body: {
            scopeId: scopeIdFor(r.scope),
            content: r.text,
            status: "observation",
            sensitivity: r.sensitivity ?? "internal",
            sourceKind: "external_object",
            sourceId: r.id,
            ...(r.entities ? { entities: r.entities } : {}),
            ...(r.topics ? { topics: r.topics } : {}),
          },
        });
        if (res.status >= 300) throw new Error(`Seeding ${r.id} failed: ${res.status} ${JSON.stringify(res.body)}`);
        if (res.body?.engineAvailable !== true) throw new Error(`Seeding ${r.id}: gateway could not reach the engine (${res.body?.message})`);
        remember(res.body.record.id, r.id);
      }
    },
    tokenFor(id) {
      if (id === "hu-john-syn") return null; // the local board: no credential
      return state.tokens[id] ?? `missing-token-${id}`;
    },
    async recall(headers, body) {
      const { client, scope, bare, ...rest } = body;
      const named = client ?? scope;
      // A bare recall sends no scopeIds; the gateway then skips client scopes by design.
      const scopeIds = named ? [scopeIdFor(named)] : bare ? undefined : await visibleScopeIds(headers);
      const res = await http(`/api/companies/${state.companyId}/memory/recall`, {
        method: "POST",
        headers: mapHeaders(headers),
        body: scopeIds ? { ...rest, scopeIds } : rest,
      });
      return translateResult(res);
    },
    async contribute(headers, body) {
      const { scope, text, id, supersedes, source, ...rest } = body;
      const res = await http(`/api/companies/${state.companyId}/memory/records`, {
        method: "POST",
        headers: mapHeaders(headers),
        body: {
          scopeId: scopeIdFor(scope),
          content: text,
          ...(source ? { sourceKind: source.kind, sourceId: source.id } : id ? { sourceKind: "external_object", sourceId: id } : {}),
          ...(supersedes ? { supersedesId: recordIdFor(supersedes) } : {}),
          ...rest,
        },
      });
      if (id && res.status < 300 && res.body?.record?.id) remember(res.body.record.id, id);
      return translateResult(res);
    },
    async review(headers, fixtureId, body) {
      return translateResult(await route("review", { id: recordIdFor(fixtureId), headers: mapHeaders(headers), body }));
    },
    async supersede(headers, fixtureId, body) {
      const { replacement, ...rest } = body;
      return translateResult(await route("supersede", { id: recordIdFor(fixtureId), headers: mapHeaders(headers), body: { replacementRecordId: recordIdFor(replacement), ...rest } }));
    },
    async remove(headers, fixtureId) {
      return translateResult(await route("remove", { id: recordIdFor(fixtureId), headers: mapHeaders(headers), body: { reason: "GRE-888 deletion test (synthetic)" } }));
    },
    async getRecord(headers, fixtureId) {
      const res = await http(`/api/companies/${state.companyId}/memory/records/${recordIdFor(fixtureId)}`, { headers: mapHeaders(headers) });
      return translateResult(res);
    },
    async createDirective(headers, body) {
      return translateResult(await route("directive", { headers: mapHeaders(headers), body: { scopeId: scopeIdFor(body.scope), content: body.text } }));
    },
    async recordHistory(fixtureId) {
      const id = recordIdFor(fixtureId);
      const h = await route("history", { id });
      const rel = await route("relationships", { id });
      if (isRouteMissing(h) || isRouteMissing(rel)) return { routeMissing: true };
      const record = h.body?.record ?? null;
      return toFixtureNames({ events: h.body?.events ?? [], chain: h.body?.chain ?? [], conflicts: record?.conflicts ?? [], relationships: listOf(rel.body), record });
    },
    // ---- phase 3 (GRE-866) --------------------------------------------------
    async createRelationship(headers, { id, from, to, type, note, source }) {
      const res = await route("relationshipCreate", {
        headers: mapHeaders(headers),
        body: { fromRecordId: recordIdFor(from), toRecordId: recordIdFor(to), type, note, ...(source ? { sourceKind: source.kind, sourceId: source.id } : {}) },
      });
      if (id && res.status < 300 && res.body?.id) name(res.body.id, id);
      return translateResult(res);
    },
    /** Sandbox database only: moves D9 times into the fixture's past. */
    async backdate({ records = {}, events = [], relationships = {} }) {
      for (const [fixtureId, at] of Object.entries(records)) {
        const id = lit(recordIdFor(fixtureId));
        await sql(`update memory_records set created_at = ${lit(at)} where id = ${id}`);
        await sql(`update memory_review_events set created_at = ${lit(at)} where record_id = ${id} and action = 'contribute'`);
      }
      for (const { record, type, at } of events) {
        await sql(`update memory_review_events set created_at = ${lit(at)} where record_id = ${lit(recordIdFor(record))} and action = ${lit(EVENT_ACTIONS[type] ?? type)}`);
      }
      for (const [fixtureId, at] of Object.entries(relationships)) {
        const uuid = [...state.names].find(([, n]) => n === fixtureId)?.[0];
        if (uuid) await sql(`update memory_relationships set created_at = ${lit(at)} where id = ${lit(uuid)}`);
      }
      return { ok: true };
    },
    /** Ground truth: stated relationships plus supersession links, by fixture name. */
    async relationshipRows() {
      const c = lit(state.companyId);
      const out = await sql(`select coalesce(json_agg(x)::text, '[]') from (
        select id, from_record_id as "from", to_record_id as "to", type, coalesce(author_agent_id::text, author_user_id) as author from memory_relationships where company_id = ${c}
        union all
        select null, r.id, r.supersedes_id, 'supersedes', coalesce(e.agent_id::text, e.user_id)
          from memory_records r left join memory_review_events e on e.record_id = r.id and e.action = 'supersede'
          where r.company_id = ${c} and r.supersedes_id is not null) x`);
      return toFixtureNames(JSON.parse(out || "[]"));
    },
    async extractedFacts() {
      const out = await sql(`select coalesce(json_agg(x)::text, '[]') from (
        select id as "factId", record_id as "recordId", coalesce(contributor_agent_id::text, contributor_user_id) as contributor
        from memory_extracted_facts where company_id = ${lit(state.companyId)}) x`);
      return { available: true, facts: toFixtureNames(JSON.parse(out || "[]")) };
    },
    /** Ground truth for inferred edges: open conflict-check rows (GRE-864 draws only these). */
    async inferredRows() {
      const out = await sql(`select coalesce(json_agg(x)::text, '[]') from (
        select record_id as a, approved_record_id as b from memory_conflicts where company_id = ${lit(state.companyId)} and state = 'open') x`);
      return { available: true, pairs: toFixtureNames(JSON.parse(out || "[]")) };
    },
    async graph(headers, f) {
      const res = await phase3View("graph", headers, { ...f, limit: 500 });
      return res.status === 200 ? { status: 200, body: { nodes: (res.body.nodes ?? []).map(p3Node), edges: (res.body.edges ?? []).map(p3Edge), raw: res.body } } : res;
    },
    async memoryList(headers, f) {
      const res = await phase3View("graph", headers, { ...f, limit: 500 });
      return res.status === 200 ? { status: 200, body: { items: (res.body.nodes ?? []).map(p3Node), raw: res.body } } : res;
    },
    async node(headers, fixtureId) {
      const res = translateResult(await route("node", { id: recordIdFor(fixtureId), headers: mapHeaders(headers) }));
      if (res.status !== 200) return res;
      const b = res.body;
      const pv = b.provenance ?? {};
      return {
        status: 200,
        body: {
          record: { id: b.record?.id, scope: b.record?.scopeId, status: b.record?.status, title: b.record?.title, content: b.record?.content },
          status: b.node?.status,
          source: b.node?.source,
          contributor: p3Actor(b.node?.contributor),
          provenance: {
            contributor: { actor: p3Actor(pv.contributor), at: pv.contributor?.at },
            reviewers: (pv.reviewers ?? []).map((r) => ({ action: r.action, actor: p3Actor(r.actor), at: r.at, related: r.relatedRecordId })),
            extraction: (pv.extraction?.facts ?? []).map((x) => ({ factId: x.id, recordId: x.recordId, contributor: x.contributorAgentId ?? x.contributorUserId, actor: "engine" })),
          },
          edges: (b.edges ?? []).map((e) => e.id),
          raw: b,
        },
      };
    },
    async edge(headers, edgeId) {
      const res = translateResult(await route("edge", { id: encodeURIComponent(edgeIdFor(edgeId)), headers: mapHeaders(headers) }));
      return res.status === 200 ? { status: 200, body: { ...p3Edge(res.body.edge), meaning: res.body.meaning, raw: res.body } } : res;
    },
    async activity(headers, f) {
      const items = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const res = await phase3View("activity", headers, { ...f, limit: 200, cursor });
        if (res.status !== 200) return res;
        items.push(...(res.body.items ?? []));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      return { status: 200, body: { items: items.map(p3Activity), raw: items } };
    },
    async counts(headers, f) {
      const res = await phase3View("counts", headers, { from: f.from, to: f.to });
      return res.status === 200
        ? { status: 200, body: { agents: (res.body.contributors ?? []).map((c) => ({ agent: p3Actor(c.contributor), contributions: c.contributionCount })), raw: res.body } }
        : res;
    },
    async reviewQueue() {
      const res = await route("conflicts", {});
      if (isRouteMissing(res)) return res;
      if (res.status >= 300) return { available: false, reason: `${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
      return { available: true, items: toFixtureNames(res.body?.groups ?? listOf(res.body)) };
    },
    async stewardQueue() {
      const res = await route("stewardQueue", {});
      if (isRouteMissing(res)) return res;
      if (res.status >= 300) return { available: false, reason: `${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
      return { available: true, items: toFixtureNames(listOf(res.body)) };
    },
    /**
     * One steward pass. The sandbox controls (`sandbox`: a clock for the audit
     * day, and a kill after N entries) are asked of GRE-887; a pass that
     * ignores a requested kill is reported as `faultIgnored`, so MT-19 is
     * inconclusive, never a pass.
     */
    async stewardRun(headers, body = {}) {
      // 22:00Z is 22:00 or 23:00 in Europe/London, so the run day is the audit
      // day all year. A killed pass keeps its lease, so the next pass runs at
      // or after `leaseUntil`, as a real resume would.
      let now = body.auditDay ? new Date(`${body.auditDay}T22:00:00.000Z`) : null;
      if (now && state.stewardLeaseUntil && now < state.stewardLeaseUntil) now = state.stewardLeaseUntil;
      const sandbox = {
        ...(now ? { now: now.toISOString() } : {}),
        ...(body.fault ? { killAfterEntries: body.fault.item } : {}),
      };
      const res = await route("stewardRun", { headers: mapHeaders(headers), body: Object.keys(sandbox).length ? { sandbox } : undefined });
      const out = translateResult(res);
      state.stewardLeaseUntil = res.status < 300 && res.body?.outcome === "killed" && res.body.leaseUntil ? new Date(res.body.leaseUntil) : null;
      if (body.fault && res.status < 300 && res.body?.outcome === "completed") {
        out.body = { ...out.body, faultIgnored: "the steward review route ran to completion instead of stopping at the requested kill" };
      }
      if (res.status < 300) {
        const report = await route("stewardReport", {});
        if (report.status < 300) out.body = { ...out.body, report: toFixtureNames(report.body?.report ?? report.body) };
      }
      return out;
    },
    async stewardLedger() {
      // No per-entry ledger in GRE-887: each page commits its counters with the cursor.
      const runs = await sql(
        `select coalesce(json_agg(r order by r.started_at), '[]') from memory_steward_runs r where r.company_id = ${lit(state.companyId)}`,
      ).catch(() => null);
      if (runs == null) return { routeMissing: true };
      const rows = JSON.parse(runs || "[]");
      const grant = await sql(`select scope_ids::text from memory_steward_grants where company_id = ${lit(state.companyId)} order by created_at desc limit 1`).catch(() => "");
      const scopeIds = grant ? JSON.parse(grant) : [];
      const ids = scopeIds.length
        ? (await sql(`select id from memory_records where company_id = ${lit(state.companyId)} and scope_id in (${scopeIds.map(lit).join(",")}) order by created_at`)).split("\n").filter(Boolean)
        : [];
      return toFixtureNames({
        seen: rows.reduce((n, r) => n + (r.entries_seen ?? 0), 0),
        expected: ids.length,
        expectedIds: ids,
        runs: rows.map((r) => ({ ...r, durationMs: r.duration_ms, queueAgeMs: null })),
      });
    },
    async grantsOf(fixtureId) {
      const agentId = state.agentIds[fixtureId];
      if (!agentId) return ["board"];
      const out = await sql(
        `select permission_key || ' ' || coalesce(scope::text, '') from principal_permission_grants
         where company_id = ${lit(state.companyId)} and principal_type = 'agent' and principal_id = ${lit(agentId)} order by 1`,
      );
      return toFixtureNames(out.split("\n").filter(Boolean));
    },
    async adminRecordRow(fixtureId) {
      const out = await sql(`select coalesce(row_to_json(x)::text, '') from (select status, content, deleted_at as "deletedAt" from memory_records where id = ${lit(recordIdFor(fixtureId))}) x`);
      return out ? JSON.parse(out) : null;
    },
    async adminFindText(text) {
      // Every gateway table (memory_*), including the phase 2 stores, searched as text.
      const tables = (await sql(`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'memory%' and table_type = 'BASE TABLE' order by 1`)).split("\n").filter(Boolean);
      const found = [];
      for (const t of tables) {
        const n = await sql(`select count(*) from ${t.replace(/[^a-z0-9_]/gi, "")} x where x::text like ${lit(`%${text}%`)}`);
        if (Number(n) > 0) found.push(t);
      }
      return { tables: found, searched: tables };
    },
    async retentionPolicy() {
      // GRE-887 item 6: backup expiry for deleted content is written in the engine runbook.
      const doc = resolve(REPO_ROOT, "doc/GS-MEMORY-ENGINE.md");
      if (!existsSync(doc)) return "";
      return readFileSync(doc, "utf8").split(/\n\s*\n/).filter((p) => /backup/i.test(p) && /delet/i.test(p)).join("\n\n");
    },
    async auditCursor() {
      return sql("select now()");
    },
    async auditSince(cursor) {
      // The gateway makes each agent's working scope on first use; name them too.
      const agentScopes = await sql(`select id, agent_id from memory_scopes where company_id = ${lit(state.companyId)} and kind = 'agent'`);
      for (const line of agentScopes.split("\n").filter(Boolean)) {
        const [id, agentId] = line.split("|");
        name(id, `agent-scope:${state.names.get(agentId) ?? agentId}`);
      }
      const out = await sql(
        `select coalesce(json_agg(o order by o.created_at), '[]') from memory_operations o
         where o.company_id = ${lit(state.companyId)} and o.created_at >= ${lit(cursor)}::timestamptz`,
      );
      return toFixtureNames(JSON.parse(out || "[]")).map((r) => ({
        actor: r.agent_id ?? r.actor_id,
        op: r.operation,
        scopes: r.scope_ids ?? [],
        decision: r.outcome === "ok" ? "allowed" : r.outcome,
        run: r.run_id,
        record: r.record_id,
        detail: r.detail,
        at: r.created_at,
      }));
    },
    async probeEngine(kind, opts) {
      return probes.probeEngine(kind, opts);
    },
    async adminBankConfig(bank) {
      const bankId = state.bankIds[bank];
      if (!engineAdmin || !bankId) return { error: "no admin read-back" };
      const out = await engineSql(`select coalesce(row_to_json(b)::text, '{}') from banks b where b.bank_id = ${lit(bankId)}`).catch((e) => `{"error":${JSON.stringify(e.message)}}`);
      const row = JSON.parse(out || "{}");
      // Hindsight 0.10.2 keeps Memory Defense as a DefensePolicy in the bank
      // config: { enabled, rules: [{ action, ... }] }. Absent means off.
      const md = row.config?.memory_defense ?? null;
      const rules = Array.isArray(md?.rules) ? md.rules : [];
      const memoryDefense = !md?.enabled ? "off" : rules.some((r) => r?.action === "block") ? "block" : "on";
      return { bankId, exists: Boolean(row.bank_id), memoryDefense, policy: md, updatedAt: row.updated_at ?? null };
    },
    async adminInspectRaw() {
      if (!engineAdmin) return { available: false, stores: {} };
      const tables = (await engineSql(
        "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
      )).split("\n").filter(Boolean);
      const stores = {};
      for (const t of tables) {
        const rows = await engineSql(`select row_to_json(x)::text from ${t.replace(/[^a-z0-9_]/gi, "")} x`);
        stores[t] = rows ? rows.split("\n") : [];
      }
      if (!stores.documents) return { available: false, stores: {} };
      return { available: true, stores };
    },
    async egress() {
      if (!cfg.egressLogPath || !existsSync(cfg.egressLogPath)) return { available: false, hosts: [] };
      let summary;
      try {
        const { stdout } = await execFileAsync(process.execPath, [resolve(REPO_ROOT, "server/scripts/memory-egress-check.mjs"), "check", "--log", cfg.egressLogPath, "--json"]);
        summary = JSON.parse(stdout);
      } catch (err) {
        summary = err.stdout ? JSON.parse(err.stdout) : null;
      }
      if (!summary || summary.empty) return { available: false, hosts: [], source: cfg.egressLogPath };
      const outside = summary.destinations.filter((d) => d.kind !== "loopback" && d.kind !== "dns-resolver");
      return {
        available: true,
        source: `${cfg.egressLogPath} (${summary.samples} samples, server/scripts/memory-egress-check.mjs)`,
        hosts: [...new Set(outside.map((d) => d.kind))],
        destinations: summary.destinations,
      };
    },
  };
}
