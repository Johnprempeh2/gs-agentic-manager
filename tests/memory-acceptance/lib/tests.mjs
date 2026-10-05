// The 11 phase 1 acceptance tests from the GRE-651 threat model, section 6:
// MT-01 to MT-09, MT-12 and MT-31. Each test returns pass, fail or
// inconclusive, with the observed evidence and the gateway audit rows.
//
// "Inconclusive" means the target could not produce the evidence the test
// needs (for example no egress log). It is never counted as a pass.

import { d7Items, record } from "./fixtures.mjs";

export const PHASE1_SEED = ["R-301", "R-302", "R-303"];

function client(target, identityId, extraHeaders = {}) {
  // A null token means the caller authenticates without one (the local board on the gsam target).
  const token = target.tokenFor(identityId);
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  return {
    recall: (body, h = {}) => target.recall({ ...headers, ...h }, body),
    contribute: (body, h = {}) => target.contribute({ ...headers, ...h }, body),
  };
}

function check(checks, ok, label) {
  checks.push({ ok: Boolean(ok), label });
}

function verdict(checks) {
  return checks.every((c) => c.ok) ? "pass" : "fail";
}

function resultIds(res) {
  return (res.body?.results ?? []).map((r) => r.id);
}

// Zero results only proves isolation when the recall really searched. A
// gateway that answers "memory unavailable" returns nothing for everyone.
function searched(res) {
  return res.status === 200 && res.body?.available !== false;
}

function denied(res) {
  return res.status === 401 || res.status === 403 || res.status === 404;
}

function noneOf(haystack, needles) {
  const s = JSON.stringify(haystack);
  return needles.every((n) => !s.includes(n));
}

async function withAudit(target, fn) {
  const cursor = await target.auditCursor();
  const out = await fn();
  const audit = await target.auditSince(cursor);
  return { out, audit };
}

function auditHas(audit, match) {
  return audit.some((row) => Object.entries(match).every(([k, v]) => (typeof v === "function" ? v(row[k], row) : row[k] === v)));
}

export const TESTS = [
  {
    id: "MT-01",
    threat: "T1 cross-client read",
    title: "Lintel recalls 'contract renewal date' and sees only Brookfield",
    async run(target) {
      const lintel = client(target, "ag-lintel-syn");
      const { out: res, audit } = await withAudit(target, () => lintel.recall({ query: "contract renewal date" }));
      const checks = [];
      check(checks, searched(res), `recall answered 200 and searched (got ${res.status}${res.body?.available === false ? ", memory unavailable" : ""})`);
      check(checks, JSON.stringify(resultIds(res)) === JSON.stringify(["R-302"]), `only R-302 returned (got ${JSON.stringify(resultIds(res))})`);
      check(checks, noneOf(res.body, ["R-301", record(scenariosRef, "R-301").text, "31 March", "cl-alder"]), "no R-301 id, text, scope or count in the response");
      check(
        checks,
        auditHas(audit, { actor: "ag-lintel-syn", op: "recall", decision: "allowed", scopes: (s) => s?.includes("cl-brook") && !s.includes("cl-alder") }),
        "audit row: ag-lintel-syn recall allowed, scope includes cl-brook and not cl-alder",
      );
      return { checks, observed: res, audit };
    },
  },
  {
    id: "MT-02",
    threat: "T1 cross-client read",
    title: "Lintel asks for cl-alder explicitly (body and X-Bank-Id) and is denied like 'not found'",
    async run(target) {
      const lintel = client(target, "ag-lintel-syn");
      const { out, audit } = await withAudit(target, async () => ({
        body: await lintel.recall({ query: "contract renewal date", client: "cl-alder" }),
        header: await lintel.recall({ query: "contract renewal date" }, { "X-Bank-Id": "cl-alder" }),
        missing: await lintel.recall({ query: "contract renewal date", client: "cl-does-not-exist" }),
      }));
      const checks = [];
      check(checks, denied(out.body), `body client=cl-alder denied (got ${out.body.status})`);
      check(checks, denied(out.header), `header X-Bank-Id: cl-alder denied (got ${out.header.status})`);
      check(
        checks,
        out.body.status === out.missing.status && JSON.stringify(out.body.body) === JSON.stringify(out.missing.body),
        "denial is identical to the response for a scope that does not exist",
      );
      check(checks, noneOf([out.body.body, out.header.body], ["R-301", "31 March"]), "no cl-alder data in either denial");
      check(
        checks,
        audit.filter((r) => r.actor === "ag-lintel-syn" && r.decision === "denied").length >= 2,
        "audit rows: both ag-lintel-syn attempts recorded as denied",
      );
      return { checks, observed: out, audit };
    },
  },
  {
    id: "MT-03",
    threat: "T2 cross-project read",
    title: "Mason (org read) recalls 'HERON' and 'acquisition' and gets nothing",
    async run(target) {
      const mason = client(target, "ag-mason-syn");
      const { out, audit } = await withAudit(target, async () => ({
        heron: await mason.recall({ query: "HERON" }),
        acquisition: await mason.recall({ query: "acquisition" }),
      }));
      const checks = [];
      check(checks, searched(out.heron) && searched(out.acquisition), "both recalls searched (not 'memory unavailable')");
      check(checks, out.heron.status === 200 && resultIds(out.heron).length === 0, `'HERON' returns zero results (got ${JSON.stringify(resultIds(out.heron))})`);
      check(checks, out.acquisition.status === 200 && resultIds(out.acquisition).length === 0, `'acquisition' returns zero results (got ${JSON.stringify(resultIds(out.acquisition))})`);
      check(checks, noneOf(out, ["HERON", "R-303", "pj-kestrel-acq"]), "no hint that pj-kestrel-acq exists");
      check(
        checks,
        audit.filter((r) => r.actor === "ag-mason-syn" && r.op === "recall" && !r.scopes?.includes("pj-kestrel-acq")).length >= 2,
        "audit rows: two ag-mason-syn recalls, neither searched pj-kestrel-acq",
      );
      return { checks, observed: out, audit };
    },
  },
  {
    id: "MT-04",
    threat: "T2 cross-project read",
    title: "Everest (org read, no grant on the sensitive project) recalls 'acquisition target' and gets nothing",
    async run(target) {
      const everest = client(target, "ag-everest-syn");
      const { out: res, audit } = await withAudit(target, () => everest.recall({ query: "acquisition target" }));
      const checks = [];
      check(checks, searched(res), "recall searched (not 'memory unavailable')");
      check(checks, res.status === 200 && resultIds(res).length === 0, `zero results (got ${res.status} ${JSON.stringify(resultIds(res))})`);
      check(checks, noneOf(res.body, ["HERON", "R-303", "pj-kestrel-acq"]), "no sensitive-project data or name");
      check(
        checks,
        auditHas(audit, { actor: "ag-everest-syn", op: "recall", scopes: (s) => Array.isArray(s) && !s.includes("pj-kestrel-acq") }),
        "audit row: ag-everest-syn recall, pj-kestrel-acq not searched",
      );
      return { checks, observed: res, audit };
    },
  },
  {
    id: "MT-05",
    threat: "T3 forged identity",
    title: "Rogue writes to org claiming to act as John",
    async run(target) {
      const rogue = client(target, "ag-rogue-syn");
      const text = "Kestrel holiday cover note (synthetic MT-05 marker).";
      const { out: res, audit } = await withAudit(target, () =>
        rogue.contribute({ scope: "org", text, actingAgentId: "hu-john-syn", onBehalfOf: "hu-john-syn" }),
      );
      const checks = [];
      const rejected = res.status >= 400 && res.status < 500;
      check(checks, rejected || res.body?.contributor === "ag-rogue-syn", `write rejected or attributed to ag-rogue-syn (got ${res.status}, contributor ${res.body?.contributor ?? "-"})`);
      check(checks, !auditHas(audit, { actor: "hu-john-syn" }), "no audit row names hu-john-syn as the actor");
      check(checks, auditHas(audit, { actor: "ag-rogue-syn", op: "contribute" }), "audit row shows the real caller ag-rogue-syn");
      if (!rejected) {
        const john = client(target, "hu-john-syn");
        const seen = await john.recall({ query: "MT-05 marker", scope: "org" });
        const stored = (seen.body?.results ?? []).filter((r) => r.text === text);
        check(checks, stored.length > 0 && stored.every((r) => r.contributor === "ag-rogue-syn"), "stored record's contributor is ag-rogue-syn, never John");
      }
      return { checks, observed: res, audit };
    },
  },
  {
    id: "MT-06",
    threat: "T3 forged identity",
    title: "Rogue presents Mason's run id, then its own expired run",
    async run(target) {
      const rogue = client(target, "ag-rogue-syn");
      const { out, audit } = await withAudit(target, async () => ({
        othersRun: await rogue.recall({ query: "care plan" }, { "X-Paperclip-Run-Id": "run-mason-live" }),
        expiredRun: await rogue.recall({ query: "care plan" }, { "X-Paperclip-Run-Id": "run-rogue-expired" }),
      }));
      const checks = [];
      // GRE-651 says "Rejected"; GSAM answers a run id mismatch with 422.
      const rejectedRun = (s) => s === 401 || s === 403 || s === 422;
      check(checks, rejectedRun(out.othersRun.status), `another agent's run id rejected (got ${out.othersRun.status})`);
      check(checks, rejectedRun(out.expiredRun.status), `expired run rejected (got ${out.expiredRun.status})`);
      check(checks, !out.othersRun.body?.results && !out.expiredRun.body?.results, "no results returned");
      check(
        checks,
        audit.filter((r) => r.actor === "ag-rogue-syn" && r.decision === "denied").length >= 2,
        "audit rows: both attempts recorded as denied for ag-rogue-syn",
      );
      return { checks, observed: out, audit };
    },
  },
  {
    id: "MT-07",
    threat: "T4 direct engine bypass",
    title: "Agent shell calls engine REST recall and retain directly, no key, guessed bank",
    needsEngine: true,
    async run(target) {
      const before = await target.adminInspectRaw();
      const recall = await target.probeEngine("rest-recall", { bank: "cl-alder" });
      const retain = await target.probeEngine("rest-retain", { bank: "cl-alder" });
      const after = await target.adminInspectRaw();
      const checks = [];
      check(checks, refusedOr401(recall), `REST recall refused or 401 (got ${describeProbe(recall)})`);
      check(checks, refusedOr401(retain), `REST retain refused or 401 (got ${describeProbe(retain)})`);
      check(checks, !recall.dataReturned && !retain.dataReturned, "no data returned");
      if (before.available && after.available) {
        check(checks, after.stores.documents.length === before.stores.documents.length, "nothing written to the engine");
      }
      return { checks, observed: { recall, retain }, audit: [], auditNote: "direct engine calls bypass the gateway; evidence is the probe result" };
    },
  },
  {
    id: "MT-08",
    threat: "T4 direct engine bypass",
    title: "Agent shell calls /mcp/cl-alder/ and /mcp with X-Bank-Id",
    needsEngine: true,
    async run(target) {
      const path = await target.probeEngine("mcp-path", { bank: "cl-alder" });
      const header = await target.probeEngine("mcp-header", { bank: "cl-alder" });
      const checks = [];
      check(checks, mcpClosed(path), `/mcp/cl-alder/ refused, 401 or 404 (got ${describeProbe(path)})`);
      check(checks, mcpClosed(header), `/mcp with X-Bank-Id refused, 401 or 404 (got ${describeProbe(header)})`);
      check(checks, !path.dataReturned && !header.dataReturned, "no data returned");
      return { checks, observed: { path, header }, audit: [], auditNote: "direct engine calls bypass the gateway; evidence is the probe result" };
    },
  },
  {
    id: "MT-09",
    threat: "T4, T13 engine config through the data plane",
    title: "Agent shell tries control plane, PostgreSQL and MCP bank-config change",
    needsEngine: true,
    async run(target) {
      const configBefore = await target.adminBankConfig("cl-alder");
      const cp = await target.probeEngine("control-plane");
      const pg = await target.probeEngine("postgres");
      const cfg = await target.probeEngine("mcp-bank-config", { bank: "cl-alder" });
      const configAfter = await target.adminBankConfig("cl-alder");
      const checks = [];
      check(checks, refusedOr401(cp), `control plane refused (got ${describeProbe(cp)})`);
      check(checks, !pg.reached || pg.loginAccepted === false, `PostgreSQL connection or login without the password refused (got ${describeProbe(pg)})`);
      check(checks, mcpClosed(cfg), `MCP bank-config update refused (got ${describeProbe(cfg)})`);
      check(checks, configBefore?.memoryDefense === "block", `Memory Defense on before the attempt (got ${configBefore?.memoryDefense})`);
      check(checks, JSON.stringify(configAfter) === JSON.stringify(configBefore), "bank config unchanged, read back by admin");
      return { checks, observed: { cp, pg, cfg, configBefore, configAfter }, audit: [], auditNote: "direct engine calls bypass the gateway; evidence is the probe result and admin read-back" };
    },
  },
  {
    id: "MT-12",
    threat: "T9 sensitive data in contributions",
    title: "Mason contributes each D7 fake secret; none is stored raw anywhere",
    needsInspect: true,
    async run(target) {
      const mason = client(target, "ag-mason-syn");
      const items = d7Items(scenariosRef);
      const { out: responses, audit } = await withAudit(target, async () => {
        const out = [];
        for (const item of items) out.push({ item: item.id, res: await mason.contribute({ scope: item.scope, text: `Synthetic note: ${item.value}` }) });
        return out;
      });
      const raw = await target.adminInspectRaw();
      const checks = [];
      for (const { item, res } of responses) {
        const value = items.find((i) => i.id === item).value;
        const blocked = res.status >= 400 && res.status < 500;
        const redacted = res.status >= 200 && res.status < 300 && !JSON.stringify(res.body).includes(value);
        check(checks, blocked || redacted, `${item} blocked or redacted (got ${res.status})`);
        check(checks, /pattern/i.test(String(res.body?.detection ?? res.body?.message ?? "")), `${item} response says detection is pattern-based`);
      }
      if (!raw.available) return { checks, observed: responses, audit, inconclusive: "admin inspection of engine stores is not available on this target" };
      for (const [store, values] of Object.entries(raw.stores)) {
        const leaked = items.filter((i) => values.some((v) => String(v).includes(i.value))).map((i) => i.id);
        check(checks, leaked.length === 0, `no raw secret in ${store}${leaked.length ? ` (found ${leaked.join(", ")})` : ""}`);
      }
      const rows = audit.filter((r) => r.actor === "ag-mason-syn" && r.op === "contribute");
      check(checks, rows.length === items.length, `audit rows: one ag-mason-syn contribute row per D7 item (want ${items.length}, got ${rows.length})`);
      return { checks, observed: responses, audit: audit.map(redactAuditRow(items)) };
    },
  },
  {
    id: "MT-31",
    threat: "T9 outbound data",
    title: "Only declared provider hosts are contacted during fixture ingest",
    async run(target) {
      const egress = await target.egress();
      const checks = [];
      if (!egress.available) return { checks, observed: egress, audit: [], inconclusive: "no egress log on this target (GRE-673 provides it for the sandbox)" };
      const undeclared = egress.hosts.filter((h) => !target.allowedEgressHosts.includes(h));
      check(checks, undeclared.length === 0, `no undeclared outbound host (found ${JSON.stringify(undeclared)}; allowed ${JSON.stringify(target.allowedEgressHosts)})`);
      return { checks, observed: egress, audit: [], auditNote: `egress source: ${egress.source}` };
    },
  },
];

// Set by runAll so tests can read fixture text without threading it through.
let scenariosRef = null;

function refusedOr401(p) {
  return !p.reached || p.status === 401 || p.status === 403;
}

// MCP is switched off on the engine (GRE-674), so 404 with no data is also a
// closed door. REST stays strict: a 404 there could hide a missing key check.
function mcpClosed(p) {
  return refusedOr401(p) || (p.status === 404 && !p.dataReturned);
}

function describeProbe(p) {
  if (!p.reached) return `not reached: ${p.detail}`;
  return p.status == null ? p.detail : `HTTP ${p.status}`;
}

function redactAuditRow(items) {
  return (row) => {
    let s = JSON.stringify(row);
    for (const i of items) s = s.split(i.value).join("[d7-redacted]");
    return JSON.parse(s);
  };
}

export async function runAll(target, { scenarios, only } = {}) {
  scenariosRef = scenarios;
  const pre = await target.preflight();
  await target.seed(PHASE1_SEED.map((id) => record(scenarios, id)));
  const results = [];
  for (const t of TESTS) {
    if (only && !only.includes(t.id)) continue;
    const started = Date.now();
    let status;
    let detail;
    try {
      if (t.needsEngine && !pre.engineUp) {
        detail = { checks: [], inconclusive: "engine not confirmed running; a refused connection would prove nothing" };
      } else {
        detail = await t.run(target);
      }
      // A failed check beats missing evidence: fail, then inconclusive, then pass.
      status = verdict(detail.checks) === "fail" ? "fail" : detail.inconclusive ? "inconclusive" : "pass";
    } catch (err) {
      status = "fail";
      detail = { checks: [{ ok: false, label: `threw: ${err?.message ?? err}` }] };
    }
    results.push({ id: t.id, threat: t.threat, title: t.title, status, ms: Date.now() - started, ...detail });
  }
  return { target: target.name, faults: target.faults ?? [], preflight: pre, results };
}
