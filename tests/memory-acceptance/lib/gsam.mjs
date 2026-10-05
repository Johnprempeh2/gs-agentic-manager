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
    ...cfg,
    engine: { host: "127.0.0.1", restPort: 28888, controlPlanePort: 9999, postgresPort: 25432, ...(cfg.engine ?? {}) },
  };
}

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
    const s = JSON.stringify(value ?? null).replace(UUID_RE, (id) => state.names.get(id.toLowerCase()) ?? id);
    return JSON.parse(s);
  }

  function name(id, kind) {
    state.names.set(id.toLowerCase(), kind);
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
      // `approve` is phase 2 and scoped `administer` has no gateway equivalent
      // (memory:admin is company-wide), so neither is granted; see grantNotes.
      for (const [right, key] of [["read", "memory:read"], ["contribute", "memory:contribute"]]) {
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
    }
  }

  const grantNotes = world.identities
    .flatMap((i) => i.grants.filter((g) => g.rights.some((r) => r === "approve" || r === "administer")).map((g) => `${i.id} ${g.scope}`))
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
          ...(primeOrg ? ["DIAGNOSTIC: --prime-org seeded one extra synthetic org record (PRIME-ORG); not an acceptance run"] : []),
        ],
      };
    },
    async seed(fixtureItems) {
      const items = primeOrg ? [{ id: "PRIME-ORG", scope: "org", text: PRIME_ORG_TEXT }, ...fixtureItems] : fixtureItems;
      for (const r of items) {
        const res = await http(`/api/companies/${state.companyId}/memory/records`, {
          method: "POST",
          body: {
            scopeId: scopeIdFor(r.scope),
            content: r.text,
            status: "observation",
            sensitivity: r.sensitivity ?? "internal",
            sourceKind: "external_object",
            sourceId: r.id,
          },
        });
        if (res.status >= 300) throw new Error(`Seeding ${r.id} failed: ${res.status} ${JSON.stringify(res.body)}`);
        if (res.body?.engineAvailable !== true) throw new Error(`Seeding ${r.id}: gateway could not reach the engine (${res.body?.message})`);
        state.records.set(res.body.record.id, r.id);
        name(res.body.record.id, r.id);
      }
    },
    tokenFor(id) {
      if (id === "hu-john-syn") return null; // the local board: no credential
      return state.tokens[id] ?? `missing-token-${id}`;
    },
    async recall(headers, body) {
      const { client, scope, ...rest } = body;
      const named = client ?? scope;
      const scopeIds = named ? [scopeIdFor(named)] : await visibleScopeIds(headers);
      const res = await http(`/api/companies/${state.companyId}/memory/recall`, {
        method: "POST",
        headers: mapHeaders(headers),
        body: { ...rest, scopeIds },
      });
      return translateResult(res);
    },
    async contribute(headers, body) {
      const { scope, text, ...rest } = body;
      const res = await http(`/api/companies/${state.companyId}/memory/records`, {
        method: "POST",
        headers: mapHeaders(headers),
        body: { scopeId: scopeIdFor(scope), content: text, ...rest },
      });
      return translateResult(res);
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
