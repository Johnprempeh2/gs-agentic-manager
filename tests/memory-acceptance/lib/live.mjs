// Live target: a sandbox GSAM server running the memory gateway (GRE-672)
// and the sandbox Hindsight engine (GRE-674). Never point this at the live
// app on port 3100 or anything under ~/GSAM/; the runner refuses port 3100.
//
// Routes follow ADR-0001 section 6 and are overridable in the config file,
// because the gateway is still being built. See README.md for the config shape.

import { readFileSync, existsSync } from "node:fs";
import net from "node:net";

const DEFAULT_ROUTES = {
  health: "/api/companies/{companyId}/memory/health",
  recall: "/api/companies/{companyId}/memory/recall",
  contribute: "/api/companies/{companyId}/memory/records",
  audit: "/api/companies/{companyId}/memory/operations",
  bankConfig: "/api/companies/{companyId}/memory/admin/banks/{bank}/config",
  inspectRaw: "/api/companies/{companyId}/memory/admin/inspect-raw",
};

export function loadLiveConfig(path) {
  if (!path || !existsSync(path)) throw new Error(`Live config not found: ${path ?? "(unset)"} (set MEMORY_ACCEPTANCE_LIVE_CONFIG)`);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const url = new URL(cfg.gatewayUrl);
  if (url.port === "3100") throw new Error("Refusing to run against port 3100 (the live app). Use a sandbox server.");
  return {
    ...cfg,
    routes: { ...DEFAULT_ROUTES, ...(cfg.routes ?? {}) },
    engine: { host: "127.0.0.1", restPort: 18888, controlPlanePort: 9999, postgresPort: 15432, ...(cfg.engine ?? {}) },
    allowedEgressHosts: cfg.allowedEgressHosts ?? ["api.anthropic.com"],
    timeoutMs: cfg.timeoutMs ?? 5000,
  };
}

export function createLiveTarget(cfg) {
  const route = (name, vars = {}) =>
    cfg.gatewayUrl.replace(/\/$/, "") +
    cfg.routes[name].replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? cfg[k] ?? ""));

  async function http(url, { method = "GET", headers = {}, body } = {}) {
    try {
      const res = await fetch(url, {
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

  const admin = () => ({ Authorization: `Bearer ${cfg.adminToken}` });
  const identityHeaders = (id) => {
    const ident = cfg.identities?.[id];
    if (!ident?.token) throw new Error(`No token for ${id} in live config`);
    return { Authorization: `Bearer ${ident.token}`, ...(ident.runId ? { "X-Paperclip-Run-Id": ident.runId } : {}) };
  };
  const tokenToId = new Map(Object.entries(cfg.identities ?? {}).map(([id, v]) => [v.token, id]));

  // Fixture run ids (run-mason-live, run-rogue-expired) map to real sandbox run ids.
  const mapRunHeader = (headers) => {
    const h = { ...headers };
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === "x-paperclip-run-id" && cfg.runIds?.[h[k]]) h[k] = cfg.runIds[h[k]];
    }
    return h;
  };

  async function engineHttp(port, path, headers = {}, method = "GET", body) {
    const res = await http(`http://${cfg.engine.host}:${port}${path}`, { method, headers, body });
    if (res.status === 0) return { reached: false, status: null, detail: res.body.message, dataReturned: false };
    const dataReturned = res.status >= 200 && res.status < 300 && JSON.stringify(res.body ?? "").length > 2;
    return { reached: true, status: res.status, detail: JSON.stringify(res.body).slice(0, 200), dataReturned };
  }

  // The engine's PostgreSQL listens on loopback, so a TCP connect from the
  // agent's shell succeeds by design. The control is that a login without
  // the engine's password is refused. Send a startup message with no password
  // and read the first reply: an auth request or an error is a refusal;
  // AuthenticationOk (R, code 0) means anyone on the box can get in.
  function pgLoginProbe(port, user) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: cfg.engine.host, port, timeout: cfg.timeoutMs });
      const done = (r) => {
        sock.destroy();
        resolve({ reached: false, status: null, dataReturned: false, ...r });
      };
      sock.once("connect", () => {
        const params = Buffer.from(`user\0${user}\0database\0${user}\0\0`);
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0);
        head.writeInt32BE(196608, 4); // protocol 3.0
        sock.write(Buffer.concat([head, params]));
      });
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 1) return;
        const type = String.fromCharCode(buf[0]);
        if (type === "E") return done({ reached: true, loginAccepted: false, detail: `login as ${user} refused: server error` });
        if (type !== "R") return done({ reached: true, loginAccepted: null, detail: `unexpected reply ${JSON.stringify(type)}` });
        if (buf.length < 9) return;
        const code = buf.readInt32BE(5);
        if (code === 0) return done({ reached: true, loginAccepted: true, detail: `login as ${user} accepted without a password` });
        done({ reached: true, loginAccepted: false, detail: `login as ${user} needs a password (auth code ${code})` });
      });
      sock.once("error", (e) => done({ detail: e.code ?? e.message }));
      sock.once("timeout", () => done({ detail: "timeout" }));
    });
  }

  async function pgProbe(port) {
    const users = ["hindsight", "postgres"];
    const results = [];
    for (const u of users) results.push(await pgLoginProbe(port, u));
    const reached = results.some((r) => r.reached);
    const accepted = results.find((r) => r.loginAccepted === true);
    const unclear = results.find((r) => r.reached && r.loginAccepted == null);
    return {
      reached,
      status: null,
      dataReturned: false,
      loginAccepted: accepted ? true : unclear ? null : reached ? false : undefined,
      detail: results.map((r) => r.detail).join("; "),
    };
  }

  let lastSince = 0;

  return {
    name: "live",
    faults: [],
    allowedEgressHosts: cfg.allowedEgressHosts,
    async preflight() {
      const res = await http(route("health"), { headers: admin() });
      const engineUp = res.status === 200 && (res.body?.engine === "up" || res.body?.engineUp === true);
      return { ok: res.status === 200, engineUp, notes: [`gateway health ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`] };
    },
    async seed(items) {
      for (const r of items) {
        const res = await http(route("contribute"), {
          method: "POST",
          headers: identityHeaders(cfg.seedIdentity ?? "hu-john-syn"),
          body: { scope: r.scope, text: r.text, kind: "source_statement", status: r.status, externalRef: r.id, sensitivity: r.sensitivity },
        });
        if (res.status >= 300) throw new Error(`Seeding ${r.id} failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
    },
    tokenFor(id) {
      return cfg.identities?.[id]?.token ?? `missing-token-${id}`;
    },
    async recall(headers, body) {
      return http(route("recall"), { method: "POST", headers: mapRunHeader(headers), body });
    },
    async contribute(headers, body) {
      return http(route("contribute"), { method: "POST", headers: mapRunHeader(headers), body });
    },
    async auditCursor() {
      lastSince = Date.now() - 1;
      return lastSince;
    },
    async auditSince(cursor) {
      const res = await http(`${route("audit")}?since=${new Date(cursor).toISOString()}`, { headers: admin() });
      const rows = Array.isArray(res.body) ? res.body : (res.body?.items ?? []);
      // Normalise to the runner's row shape: actor, op, scopes, decision.
      return rows.map((r) => ({
        ...r,
        actor: r.actor ?? r.actorAgentId ?? r.actorUserId ?? tokenToId.get(r.token),
        op: r.op ?? r.operation,
        scopes: r.scopes ?? (r.scopeIds ? r.scopeIds : r.scope ? [r.scope] : []),
        decision: r.decision ?? r.outcome,
      }));
    },
    async probeEngine(kind, { bank = "cl-alder" } = {}) {
      const { restPort, controlPlanePort, postgresPort } = cfg.engine;
      const bankId = cfg.bankIds?.[bank] ?? bank;
      switch (kind) {
        case "rest-recall":
          return engineHttp(restPort, `/v1/default/banks/${bankId}/memories/recall`, {}, "POST", { query: "contract renewal date" });
        case "rest-retain":
          return engineHttp(restPort, `/v1/default/banks/${bankId}/memories`, {}, "POST", { items: [{ content: "direct-probe (synthetic)" }] });
        case "mcp-path":
          return engineHttp(restPort, `/mcp/${bankId}/`, { Accept: "application/json, text/event-stream" }, "POST", mcpListTools());
        case "mcp-header":
          return engineHttp(restPort, `/mcp`, { "X-Bank-Id": bankId, Accept: "application/json, text/event-stream" }, "POST", mcpListTools());
        case "mcp-bank-config":
          return engineHttp(restPort, `/mcp/${bankId}/`, { Accept: "application/json, text/event-stream" }, "POST", {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "update_bank_config", arguments: { memory_defense: "off" } },
          });
        case "control-plane":
          return engineHttp(controlPlanePort, "/");
        case "postgres":
          return pgProbe(postgresPort);
        default:
          throw new Error(`Unknown probe: ${kind}`);
      }
    },
    async adminBankConfig(bank) {
      const res = await http(route("bankConfig", { bank: cfg.bankIds?.[bank] ?? bank }), { headers: admin() });
      return res.status === 200 ? res.body : { error: res.status };
    },
    async adminInspectRaw() {
      const res = await http(route("inspectRaw"), { headers: admin() });
      if (res.status !== 200 || !res.body?.stores) return { available: false, stores: {} };
      return { available: true, stores: res.body.stores };
    },
    async egress() {
      if (!cfg.egressLogPath || !existsSync(cfg.egressLogPath)) return { available: false, hosts: [] };
      const hosts = readFileSync(cfg.egressLogPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l).host;
          } catch {
            return l.split(/\s+/)[0];
          }
        })
        .filter(Boolean);
      return { available: true, source: cfg.egressLogPath, hosts: [...new Set(hosts)] };
    },
  };
}

function mcpListTools() {
  return { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
}
