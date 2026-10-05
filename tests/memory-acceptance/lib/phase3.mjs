// Phase 3 acceptance tests (GRE-866): the memory graph, agent contribution
// activity, provenance and permissions, from plan GRE-646 section 8.
//
// | Plan point                                   | Test  |
// |----------------------------------------------|-------|
// | 8.1.1 no made-up edges                       | MT-40 |
// | 8.1.4 explicit vs inferred, no cause         | MT-41 |
// | 8.1.2, 8.1.5 filters; list = graph           | MT-42 |
// | 8.1.3 node and edge detail                   | MT-43 |
// | 8.2.1, 8.2.2 activity by agent and date      | MT-44 |
// | 8.2.3 counts = drill-down, activity only     | MT-45 |
// | 8.3.1 three roles stay separate              | MT-46 |
// | 8.3.2 extracted facts trace back             | MT-47 |
// | 8.3.3 contribution -> graph -> source, back  | MT-48 |
// | 8.3.4 one status model in every view         | MT-49 |
// | 8.4.1, 8.4.2 graph, list, detail leaks       | MT-50 |
// | 8.4.2 activity and count leaks               | MT-51 |
// | 8.4.3 empty and restricted views are clean   | MT-52 |
//
// Fixture D9 (`fixtures/graph.json`) is seeded once per run: several agents
// contribute, John reviews (client scopes are owner-only), relationships are
// stated, one record is edited by supersession, and the times are moved into
// the fixture's past with the target's sandbox-only `backdate`.
//
// The tests read a normalised shape (see double-graph.mjs). The gsam target
// maps the gateway's routes and field names onto it.

import { check, client } from "./checks.mjs";
import { RouteMissing } from "./phase2.mjs";

const PHASE3_STATUSES = ["unreviewed", "approved", "disputed", "superseded"];
const CAUSAL_RE = /\b(cause[sd]?|causing|because|leads? to|led to|results? in|resulted in|proves?|proved|therefore|due to|so that)\b/i;
const SCORE_KEY_RE = /score|rank|rating|quality|grade|best|top|percentile/i;
const NOWHERE = "R-999";

function routeMissing(res) {
  return res?.status === 404 && res.body?.error === "API route not found";
}

function must(res, what) {
  if (routeMissing(res)) throw new RouteMissing(`${what}: the gateway has no route for this yet`);
  if (!res || res.status === 0 || res.status >= 300) throw new Error(`${what} failed: ${res?.status} ${JSON.stringify(res?.body).slice(0, 300)}`);
  return res;
}

/** A read view. A missing route is inconclusive; any other status is the test's to judge. */
function viewed(res, what) {
  if (routeMissing(res)) throw new RouteMissing(`${what}: the gateway has no route for this yet`);
  return res;
}

function p3(target, identity) {
  const token = target.tokenFor(identity);
  const h = token ? { Authorization: `Bearer ${token}` } : {};
  return {
    graph: async (f = {}) => viewed(await target.graph(h, f), "graph"),
    list: async (f = {}) => viewed(await target.memoryList(h, f), "list"),
    node: async (id) => viewed(await target.node(h, id), "node detail"),
    edge: async (id) => viewed(await target.edge(h, id), "edge detail"),
    activity: async (f = {}) => viewed(await target.activity(h, f), "activity"),
    counts: async (f = {}) => viewed(await target.counts(h, f), "counts"),
  };
}

const nodesOf = (res) => res.body?.nodes ?? [];
const edgesOf = (res) => res.body?.edges ?? [];
const itemsOf = (res) => res.body?.items ?? [];
const ids = (xs) => xs.map((x) => x.id ?? x.recordId);
const pairKey = (a, b) => [a, b].sort().join("~");
const sameSet = (a, b) => a.length === b.length && [...new Set(a)].every((x) => b.includes(x));
const today = () => new Date().toISOString().slice(0, 10);
const day = (iso) => String(iso ?? "").slice(0, 10);

function inRange(at, { from, to }) {
  const d = day(at);
  return d >= from && d <= to;
}

function g9(ctx) {
  return ctx.graph;
}

function d9(ctx, id) {
  const r = g9(ctx).records.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown D9 record ${id}`);
  return r;
}

function readScopes(ctx, identity) {
  const ident = ctx.world.identities.find((i) => i.id === identity);
  return ident.grants.filter((g) => g.rights.includes("read")).map((g) => g.scope);
}

/** Every agent and person that contributes in D9. */
function contributors(ctx) {
  return [...new Set(g9(ctx).records.map((r) => r.contributor))];
}

/** Fixture count of D9 contributions by `agent` in `range` that `caller` may read. */
function expectedCount(ctx, caller, agent, range) {
  const scopes = readScopes(ctx, caller);
  return g9(ctx).records.filter((r) => r.contributor === agent && scopes.includes(r.scope) && inRange(r.at, range)).length;
}

function countOf(res, agent) {
  const row = (res.body?.agents ?? []).find((a) => a.agent === agent);
  return row ? Number(row.contributions ?? row.count ?? 0) : 0;
}

function leakedStrings(value, strings) {
  const s = JSON.stringify(value ?? null);
  return strings.filter((x) => s.includes(x));
}

function leakedIds(value, recordIds) {
  const s = JSON.stringify(value ?? null);
  return recordIds.filter((id) => new RegExp(`\\b${id}\\b`).test(s));
}

function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (out.add(k), keysDeep(v, out));
  return out;
}

/** A sentence that says cause, unless it denies it ("does not prove that one caused another"). */
function claimsCause(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => CAUSAL_RE.test(sentence) && !/\b(not|never|no|doesn't|cannot)\b/i.test(sentence));
}

function eventsOf(item) {
  return item?.history ?? item?.events ?? [];
}

function actorOf(x) {
  return typeof x === "string" ? x : x?.actor ?? x?.agent ?? x?.id ?? null;
}

async function ensure(ctx, key, fn) {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
}

/** Seed D9 once: contributions, reviews, the edit, stated relationships, then backdate. */
export function ensureD9(target, ctx) {
  return ensure(ctx, "D9", async () => {
    const g = g9(ctx);
    const contribute = async (r) => {
      const body = { id: r.id, scope: r.scope, text: r.text, title: r.title, entities: r.entities, topics: r.topics, status: "proposal", source: r.source };
      must(await client(target, r.contributor).contribute(body), `${r.contributor} contributes ${r.id}`);
    };
    for (const r of g.records.filter((x) => !x.afterReviews)) await contribute(r);
    for (const rv of g.reviews) must(await client(target, rv.actor).review(rv.record, { action: rv.action, reason: rv.reason }), `${rv.actor} ${rv.action}s ${rv.record}`);
    // R-911 meets an approved record, so the conflict check opens the one inferred edge.
    for (const r of g.records.filter((x) => x.afterReviews)) await contribute(r);
    for (const s of g.supersessions) must(await client(target, s.actor).supersede(s.old, { replacement: s.replacement, reason: s.reason }), `${s.actor} supersedes ${s.old} with ${s.replacement}`);
    const h = (who) => {
      const t = target.tokenFor(who);
      return t ? { Authorization: `Bearer ${t}` } : {};
    };
    for (const e of g.relationships) {
      must(await target.createRelationship(h(e.author), { id: e.id, from: e.from, to: e.to, type: e.type, note: e.note, source: e.source }), `${e.author} states ${e.id}`);
    }
    const eventType = { approve: "approved", dispute: "disputed" };
    const dated = typeof target.backdate === "function";
    if (dated) {
      await target.backdate({
        records: Object.fromEntries(g.records.map((r) => [r.id, r.at])),
        events: [
          ...g.reviews.map((rv) => ({ record: rv.record, type: eventType[rv.action], at: rv.at })),
          ...g.supersessions.flatMap((s) => [
            { record: s.old, type: "superseded_by", at: s.at },
            { record: s.replacement, type: "supersede", at: s.at },
          ]),
        ],
        relationships: Object.fromEntries(g.relationships.map((e) => [e.id, e.at])),
      });
    }
    return { dated };
  });
}

function needDated(seed) {
  if (!seed.dated) throw new RouteMissing("target cannot backdate records in the sandbox, so date ranges have nothing to split");
}

export const PHASE3_TESTS = [
  {
    id: "MT-40",
    phase: 3,
    threat: "8.1.1 no made-up edges",
    title: "Every graph edge is a stored relationship, supersession or open conflict-check row; unrelated pairs have no edge",
    needs: ["graph", "createRelationship", "relationshipRows", "inferredRows"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const res = await p3(target, "hu-john-syn").graph();
      const checks = [];
      check(checks, res.status === 200, `John's graph answers 200 (got ${res.status})`);
      const edges = edgesOf(res);
      const stated = await target.relationshipRows();
      const engine = await target.inferredRows();
      if (!engine.available) return { checks, inconclusive: `stored inferred links not readable: ${engine.reason ?? "no admin read"}` };
      const statedKeys = new Set(stated.map((r) => `${r.from}>${r.to}>${r.type}`));
      const engineKeys = new Set(engine.pairs.map((p) => pairKey(p.a, p.b)));
      const explicit = edges.filter((e) => e.kind === "explicit");
      const inferred = edges.filter((e) => e.kind === "inferred");
      const other = edges.filter((e) => !["explicit", "inferred"].includes(e.kind));
      check(checks, other.length === 0, `every edge is explicit or inferred (other kinds: ${JSON.stringify(other.map((e) => e.kind))})`);
      const unbackedExplicit = explicit.filter((e) => !statedKeys.has(`${e.from}>${e.to}>${e.type}`));
      check(checks, unbackedExplicit.length === 0, `every explicit edge has a stored relationship row (${explicit.length} edges; unbacked ${JSON.stringify(unbackedExplicit.map((e) => e.id))})`);
      const unbackedInferred = inferred.filter((e) => !engineKeys.has(pairKey(e.from, e.to)));
      check(checks, unbackedInferred.length === 0, `every inferred edge has a stored open conflict-check row (${inferred.length} edges; unbacked ${JSON.stringify(unbackedInferred.map((e) => e.id))})`);
      for (const e of g9(ctx).relationships) {
        const n = explicit.filter((x) => x.from === e.from && x.to === e.to && x.type === e.type).length;
        check(checks, n === 1, `${e.id} (${e.from} ${e.type} ${e.to}) is drawn exactly once (got ${n})`);
      }
      for (const p of g9(ctx).noEdgePairs) {
        const n = edges.filter((x) => pairKey(x.from, x.to) === pairKey(p.a, p.b)).length;
        check(checks, n === 0, `no edge ${p.a} ~ ${p.b}: ${p.why} (got ${n})`);
      }
      return { checks };
    },
  },
  {
    id: "MT-41",
    phase: 3,
    threat: "8.1.4 explicit vs inferred",
    title: "Stated relationships are explicit with type, author and source; check-made links are inferred and never claim cause",
    needs: ["graph", "edge", "createRelationship"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const res = await john.graph();
      const checks = [];
      const edges = edgesOf(res);
      for (const e of g9(ctx).relationships) {
        const got = edges.find((x) => x.from === e.from && x.to === e.to && x.type === e.type);
        check(checks, got?.kind === "explicit", `${e.id} is explicit (got ${got?.kind ?? "absent"})`);
        check(checks, actorOf(got?.author) === e.author, `${e.id} author is ${e.author} (got ${JSON.stringify(got?.author)})`);
        check(checks, got?.source?.id === e.source.id, `${e.id} source is ${e.source.kind} ${e.source.id} (got ${JSON.stringify(got?.source)})`);
      }
      const inferred = edges.filter((x) => x.kind === "inferred");
      for (const x of inferred) {
        const who = actorOf(x.author);
        check(checks, !who || /system|engine|check|hindsight/i.test(who), `${x.id} inferred author is a check or the engine, not a person or agent (got ${JSON.stringify(x.author)})`);
      }
      const words = [...edges, ...(await Promise.all(inferred.slice(0, 20).map(async (x) => (await john.edge(x.id)).body)))].filter((x) => x && x.kind === "inferred");
      const causal = words.filter((x) => claimsCause(x.label) || claimsCause(x.meaning));
      check(checks, causal.length === 0, `no inferred edge label or meaning claims cause (${JSON.stringify(causal.map((x) => x.label ?? x.meaning))})`);
      const want = g9(ctx).expectedInferred;
      const seen = want.filter((w) => inferred.some((x) => pairKey(x.from, x.to) === pairKey(w.a, w.b)));
      const explicitPairs = new Set(edges.filter((x) => x.kind === "explicit").map((x) => pairKey(x.from, x.to)));
      check(checks, want.every((w) => !explicitPairs.has(pairKey(w.a, w.b))), "expected associations are never drawn as explicit");
      check(checks, seen.length === want.length, `expected inferred links are drawn as inferred (${JSON.stringify(want.map((w) => `${w.a}~${w.b}`))}; seen ${seen.length})`);
      return { checks };
    },
  },
  {
    id: "MT-42",
    phase: 3,
    threat: "8.1.2, 8.1.5 filters and list",
    title: "Search and the agent, scope and status filters work; the list shows the same records as the graph",
    needs: ["graph", "memoryList"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const checks = [];
      const recs = g9(ctx).records;
      const finalStatus = { "R-901": "approved", "R-902": "disputed", "R-903": "superseded", "R-904": "approved", "R-905": "approved", "R-906": "unreviewed", "R-907": "approved", "R-908": "unreviewed", "R-909": "unreviewed", "R-910": "unreviewed", "R-911": "unreviewed" };
      const cases = [
        { f: {}, want: recs.map((r) => r.id), exact: false },
        { f: { agent: "ag-mason-syn" }, want: ["R-901", "R-902", "R-910"], exact: true },
        { f: { agent: "ag-wren-syn" }, want: ["R-905", "R-906"], exact: true },
        { f: { scope: "cl-brook" }, want: ["R-905", "R-906"], exact: false },
        { f: { scope: "pj-alder-site" }, want: ["R-908"], exact: true },
        { f: { status: "disputed" }, want: ["R-902"], exact: false },
        { f: { status: "superseded" }, want: ["R-903"], exact: false },
        { f: { q: "WAGTAIL" }, want: ["R-905", "R-906"], exact: true },
        { f: { q: "supplier sheet" }, want: ["R-902", "R-907", "R-908", "R-911"], exact: true },
        { f: { agent: "ag-scribe-syn", scope: "cl-alder", status: "approved" }, want: ["R-904"], exact: true },
      ];
      for (const { f, want, exact } of cases) {
        const g = await john.graph(f);
        const l = await john.list(f);
        const gIds = ids(nodesOf(g));
        const lIds = ids(itemsOf(l));
        const label = JSON.stringify(f);
        check(checks, g.status === 200 && l.status === 200, `${label}: graph and list answer 200 (got ${g.status}, ${l.status})`);
        // Exact among D9 records; other phases' records are checked against the filter below.
        const got = exact ? sameSet(gIds.filter((x) => finalStatus[x]), want) : want.every((x) => gIds.includes(x));
        check(checks, got, `${label}: graph has ${exact ? "exactly " : ""}${JSON.stringify(want)} (got ${JSON.stringify(gIds)})`);
        check(checks, sameSet(gIds, lIds), `${label}: list shows the same records as the graph (list ${JSON.stringify(lIds)})`);
        const nodes = nodesOf(g);
        if (f.agent) check(checks, nodes.every((n) => actorOf(n.contributor) === f.agent), `${label}: every node is contributed by ${f.agent}`);
        if (f.scope) check(checks, nodes.every((n) => n.scope === f.scope), `${label}: every node is in ${f.scope}`);
        if (f.status) check(checks, nodes.every((n) => n.status === f.status), `${label}: every node is ${f.status}`);
        const d9Nodes = nodes.filter((n) => finalStatus[n.id]);
        check(checks, d9Nodes.every((n) => n.status === finalStatus[n.id]), `${label}: D9 statuses as reviewed (${JSON.stringify(d9Nodes.filter((n) => n.status !== finalStatus[n.id]).map((n) => `${n.id}=${n.status}`))})`);
        const nodeIds = new Set(gIds);
        check(checks, edgesOf(g).every((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), `${label}: every edge joins two nodes in the filtered view`);
      }
      return { checks };
    },
  },
  {
    id: "MT-43",
    phase: 3,
    threat: "8.1.3 node and edge detail",
    title: "A node shows its memory, source and status; an edge shows what the link means and where it came from",
    needs: ["node", "edge", "graph"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const checks = [];
      for (const id of ["R-901", "R-902", "R-903", "R-906"]) {
        const r = d9(ctx, id);
        const res = await john.node(id);
        const b = res.body ?? {};
        check(checks, res.status === 200, `${id} detail answers 200 (got ${res.status})`);
        check(checks, JSON.stringify(b.record ?? b).includes(r.text), `${id} detail holds the memory text`);
        check(checks, b.source?.kind === r.source.kind && b.source?.id === r.source.id, `${id} source is ${r.source.kind} ${r.source.id} (got ${JSON.stringify(b.source)})`);
        check(checks, PHASE3_STATUSES.includes(b.status ?? b.record?.status), `${id} detail shows a phase 2 status (got ${b.status ?? b.record?.status})`);
      }
      const edges = edgesOf(await john.graph());
      for (const e of g9(ctx).relationships) {
        const got = edges.find((x) => x.from === e.from && x.to === e.to && x.type === e.type);
        if (!got) {
          check(checks, false, `${e.id} is in the graph`);
          continue;
        }
        const res = await john.edge(got.id);
        const b = res.body ?? {};
        check(checks, res.status === 200, `${e.id} edge detail answers 200 (got ${res.status})`);
        check(checks, Boolean(b.meaning ?? b.label) && b.type === e.type, `${e.id} detail says what the link means (type ${b.type}, meaning ${JSON.stringify(b.meaning ?? b.label)})`);
        check(checks, b.source?.id === e.source.id && actorOf(b.author) === e.author, `${e.id} detail says where it came from (${JSON.stringify(b.source)}, by ${JSON.stringify(b.author)})`);
      }
      const inferred = edges.find((x) => x.kind === "inferred");
      if (inferred) {
        const b = (await john.edge(inferred.id)).body ?? {};
        check(checks, b.kind === "inferred" && Boolean(b.meaning ?? b.label), `inferred ${inferred.id} detail says it is an engine association (${JSON.stringify(b.meaning ?? b.label)})`);
      }
      return { checks };
    },
  },
  {
    id: "MT-44",
    phase: 3,
    threat: "8.2.1, 8.2.2 activity feed",
    title: "Activity by agent and date shows contributor, time, origin, source, status, edits and supersession",
    needs: ["activity", "backdate"],
    async run(target, ctx) {
      needDated(await ensureD9(target, ctx));
      const john = p3(target, "hu-john-syn");
      const checks = [];
      const all = { from: "2026-09-28", to: "2026-10-04" };
      for (const agent of contributors(ctx)) {
        const res = await john.activity({ agent, ...all });
        const want = g9(ctx).records.filter((r) => r.contributor === agent).map((r) => r.id);
        const got = ids(itemsOf(res));
        check(checks, res.status === 200 && sameSet(got, want), `${agent} ${all.from}..${all.to}: ${JSON.stringify(want)} (got ${res.status} ${JSON.stringify(got)})`);
        for (const it of itemsOf(res)) {
          const r = g9(ctx).records.find((x) => x.id === (it.recordId ?? it.id));
          if (!r) continue;
          check(checks, actorOf(it.contributor) === r.contributor, `${r.id} contributor ${r.contributor} (got ${JSON.stringify(it.contributor)})`);
          check(checks, day(it.at ?? it.createdAt) === day(r.at), `${r.id} time is ${day(r.at)} (got ${it.at ?? it.createdAt})`);
          const origin = it.origin ?? it.source;
          check(checks, origin?.id === r.source.id, `${r.id} origin ${r.source.kind} ${r.source.id} (got ${JSON.stringify(origin)})`);
          check(checks, PHASE3_STATUSES.includes(it.status), `${r.id} status is a phase 2 value (got ${it.status})`);
        }
      }
      const split = await john.activity({ agent: "ag-mason-syn", from: "2026-10-01", to: "2026-10-04" });
      check(checks, sameSet(ids(itemsOf(split)), ["R-910"]), `Mason 2026-10-01..04 holds only R-910 (got ${JSON.stringify(ids(itemsOf(split)))})`);
      const scribe = itemsOf(await john.activity({ agent: "ag-scribe-syn", ...all }));
      const r903 = scribe.find((x) => (x.recordId ?? x.id) === "R-903");
      const r904 = scribe.find((x) => (x.recordId ?? x.id) === "R-904");
      check(checks, r903?.status === "superseded" && /R-904/.test(JSON.stringify(eventsOf(r903))), `R-903 shows superseded by the edit R-904 (${JSON.stringify(eventsOf(r903))})`);
      check(checks, r904 && /R-903/.test(JSON.stringify(eventsOf(r904))), "R-904 history names the record it edits (R-903)");
      const mason = itemsOf(await john.activity({ agent: "ag-mason-syn", ...all }));
      const r902 = mason.find((x) => (x.recordId ?? x.id) === "R-902");
      check(checks, r902?.status === "disputed" && eventsOf(r902).some((e) => /disput/i.test(e.action ?? e.type) && actorOf(e.actor ?? e) === "hu-john-syn"), "R-902 shows John's dispute in its history");
      return { checks };
    },
  },
  {
    id: "MT-45",
    phase: 3,
    threat: "8.2.3 counts",
    title: "Per-agent counts equal the drill-down records for every agent and date range, and are activity, not quality",
    needs: ["counts", "activity", "backdate"],
    async run(target, ctx) {
      needDated(await ensureD9(target, ctx));
      const checks = [];
      const ranges = [...g9(ctx).dateRanges, { from: today(), to: today() }];
      for (const caller of ["hu-john-syn", "ag-mason-syn", "ag-lintel-syn"]) {
        const v = p3(target, caller);
        for (const range of ranges) {
          const res = await v.counts(range);
          check(checks, res.status === 200, `${caller} counts ${range.from}..${range.to} answer 200 (got ${res.status})`);
          const listed = (res.body?.agents ?? []).map((a) => a.agent);
          for (const agent of [...new Set([...listed, ...contributors(ctx)])]) {
            const n = countOf(res, agent);
            const drill = itemsOf(await v.activity({ agent, ...range }));
            check(checks, n === drill.length, `${caller} sees ${agent} ${range.from}..${range.to}: count ${n} = drill-down ${drill.length}`);
            if (range.to < today()) {
              const want = expectedCount(ctx, caller, agent, range);
              check(checks, n === want, `${caller} sees ${agent} ${range.from}..${range.to}: ${want} D9 contributions (got ${n})`);
            }
          }
        }
      }
      const res = await p3(target, "hu-john-syn").counts({ from: "2026-09-28", to: "2026-10-04" });
      const scoreKeys = [...keysDeep(res.body)].filter((k) => SCORE_KEY_RE.test(k));
      check(checks, scoreKeys.length === 0, `no score, rank or quality fields (found ${JSON.stringify(scoreKeys)})`);
      return { checks };
    },
  },
  {
    id: "MT-46",
    phase: 3,
    threat: "8.3.1 separate roles",
    title: "Contributor, reviewer or editor, and engine extraction stay separate on every record",
    needs: ["node"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const checks = [];
      const cases = [
        { id: "R-901", contributor: "ag-mason-syn", reviewer: "hu-john-syn", action: /approv/i },
        { id: "R-902", contributor: "ag-mason-syn", reviewer: "hu-john-syn", action: /disput/i },
        { id: "R-903", contributor: "ag-scribe-syn", reviewer: "hu-john-syn", action: /supersed/i },
        { id: "R-904", contributor: "ag-scribe-syn", reviewer: "hu-john-syn", action: /supersed/i },
        { id: "R-907", contributor: "ag-rogue-syn", reviewer: "hu-john-syn", action: /approv/i },
      ];
      for (const c of cases) {
        const b = (await john.node(c.id)).body ?? {};
        const pv = b.provenance ?? {};
        check(checks, actorOf(pv.contributor) === c.contributor, `${c.id} contributor stays ${c.contributor} after review (got ${JSON.stringify(pv.contributor)})`);
        const reviewers = pv.reviewers ?? [];
        check(checks, reviewers.some((r) => actorOf(r) === c.reviewer && c.action.test(r.action ?? r.type ?? "")), `${c.id} lists ${c.reviewer} as reviewer (${JSON.stringify(reviewers)})`);
        check(checks, !reviewers.some((r) => /engine|hindsight/i.test(actorOf(r) ?? "")), `${c.id}: the engine is never a reviewer`);
        check(checks, !reviewers.some((r) => actorOf(r) === c.contributor && /approv/i.test(r.action ?? "")), `${c.id}: the contributor is never listed as approver`);
        const ext = pv.extraction ?? [];
        check(checks, ext.every((x) => actorOf(x.actor ?? "engine") !== c.reviewer || /engine/i.test(actorOf(x.actor ?? "engine"))), `${c.id}: extraction entries are the engine's, not the reviewer's`);
      }
      return { checks };
    },
  },
  {
    id: "MT-47",
    phase: 3,
    threat: "8.3.2 extraction provenance",
    title: "Every engine-extracted fact traces back to its record, contributing agent and source",
    needs: ["extractedFacts", "node"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const truth = await target.extractedFacts();
      const checks = [];
      if (!truth.available) return { checks, inconclusive: `extracted facts not readable: ${truth.reason ?? "no admin read"}` };
      const d9Ids = new Set(g9(ctx).records.map((r) => r.id));
      const facts = truth.facts.filter((f) => d9Ids.has(f.recordId));
      if (facts.length === 0) return { checks, inconclusive: "the engine extracted no facts from D9 (chunks mode keeps text as-is, so there is nothing to trace)" };
      const john = p3(target, "hu-john-syn");
      const unlinked = truth.facts.filter((f) => !f.recordId || !f.contributor);
      check(checks, unlinked.length === 0, `every stored extracted fact names a record and a contributor (${unlinked.length} of ${truth.facts.length} do not)`);
      for (const id of [...new Set(facts.map((f) => f.recordId))]) {
        const r = d9(ctx, id);
        const b = (await john.node(id)).body ?? {};
        const ext = b.provenance?.extraction ?? [];
        check(checks, ext.length > 0, `${id} detail lists its extracted facts`);
        check(checks, ext.every((x) => x.recordId === id && actorOf(x.contributor) === r.contributor), `${id} extracted facts trace to ${r.contributor} (${JSON.stringify(ext.map((x) => x.contributor))})`);
        check(checks, b.source?.id === r.source.id, `${id} extracted facts reach the original source ${r.source.id} through the record`);
      }
      return { checks };
    },
  },
  {
    id: "MT-48",
    phase: 3,
    threat: "8.3.3 navigation",
    title: "Contribution -> place in graph -> source, and source -> graph -> contribution",
    needs: ["activity", "graph", "node", "memoryList"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const checks = [];
      for (const id of ["R-901", "R-905", "R-904"]) {
        const r = d9(ctx, id);
        const item = itemsOf(await john.activity({ agent: r.contributor })).find((x) => (x.recordId ?? x.id) === id);
        const nodeId = item?.nodeId ?? item?.links?.graph?.nodeId ?? item?.recordId;
        check(checks, Boolean(nodeId), `${id}: the contribution names its graph node (${JSON.stringify(nodeId)})`);
        const placed = ids(nodesOf(await john.graph({ agent: r.contributor }))).includes(nodeId);
        check(checks, placed, `${id}: that node is in the graph filtered to ${r.contributor}`);
        const b = (await john.node(nodeId)).body ?? {};
        check(checks, b.source?.id === r.source.id, `${id}: the node leads to source ${r.source.kind} ${r.source.id} (got ${JSON.stringify(b.source)})`);
        const fromSource = ids(itemsOf(await john.list({ q: r.source.id })));
        check(checks, fromSource.includes(id), `${id}: searching source ${r.source.id} finds the memory (got ${JSON.stringify(fromSource)})`);
        const back = b.links?.activity?.agent ?? actorOf(b.provenance?.contributor) ?? actorOf(b.contributor);
        const backItems = ids(itemsOf(await john.activity({ agent: back })));
        check(checks, back === r.contributor && backItems.includes(id), `${id}: the node leads back to ${r.contributor}'s contribution`);
      }
      return { checks };
    },
  },
  {
    id: "MT-49",
    phase: 3,
    threat: "8.3.4 states",
    title: "Unreviewed, approved, disputed and superseded match in graph, list, activity and detail",
    needs: ["graph", "memoryList", "activity", "node"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const john = p3(target, "hu-john-syn");
      const checks = [];
      const want = { "R-901": "approved", "R-902": "disputed", "R-903": "superseded", "R-904": "approved", "R-906": "unreviewed", "R-910": "unreviewed" };
      const g = nodesOf(await john.graph());
      const l = itemsOf(await john.list());
      const a = itemsOf(await john.activity({}));
      const all = [...g, ...l, ...a].map((x) => x.status);
      const odd = [...new Set(all.filter((s) => !PHASE3_STATUSES.includes(s)))];
      check(checks, odd.length === 0, `only phase 2 status values appear (others: ${JSON.stringify(odd)})`);
      for (const [id, status] of Object.entries(want)) {
        const seen = {
          graph: g.find((x) => x.id === id)?.status,
          list: l.find((x) => x.id === id)?.status,
          activity: a.find((x) => (x.recordId ?? x.id) === id)?.status,
          detail: ((await john.node(id)).body ?? {}).status,
        };
        check(checks, Object.values(seen).every((s) => s === status), `${id} is ${status} everywhere (${JSON.stringify(seen)})`);
      }
      return { checks };
    },
  },
  {
    id: "MT-50",
    phase: 3,
    threat: "8.4.1, 8.4.2 graph and list leaks",
    title: "Restricted callers see no hidden node, edge, label or dangling edge in the graph, list or detail",
    needs: ["graph", "memoryList", "node", "edge"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const checks = [];
      const johnEdges = edgesOf(await p3(target, "hu-john-syn").graph());
      for (const [caller, r] of Object.entries(g9(ctx).restricted)) {
        const v = p3(target, caller);
        const g = await v.graph();
        const l = await v.list();
        const scopes = readScopes(ctx, caller);
        for (const [what, res] of [["graph", g], ["list", l]]) {
          check(checks, res.status === 200, `${caller} ${what} answers 200 (got ${res.status})`);
          check(checks, leakedIds(res.body, r.hiddenRecords).length === 0, `${caller} ${what}: no hidden record ids (${JSON.stringify(leakedIds(res.body, r.hiddenRecords))})`);
          check(checks, leakedStrings(res.body, r.hiddenStrings).length === 0, `${caller} ${what}: no hidden labels (${JSON.stringify(leakedStrings(res.body, r.hiddenStrings))})`);
        }
        const nodes = nodesOf(g);
        check(checks, nodes.every((n) => scopes.includes(n.scope)), `${caller}: every node is in a scope it may read`);
        const nodeIds = new Set(ids(nodes));
        const dangling = edgesOf(g).filter((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to));
        check(checks, dangling.length === 0, `${caller}: no dangling edges (${JSON.stringify(dangling.map((e) => e.id))})`);
        for (const scope of ["cl-brook", "cl-alder", "pj-kestrel-acq", "pj-alder-site"].filter((s) => !scopes.includes(s))) {
          const hidden = await v.graph({ scope });
          const nowhere = await v.graph({ scope: "cl-nowhere" });
          check(checks, hidden.status === nowhere.status && nodesOf(hidden).length === 0 && edgesOf(hidden).length === 0, `${caller} filtering by hidden ${scope} looks like an unknown scope (${hidden.status} vs ${nowhere.status}, ${nodesOf(hidden).length} nodes)`);
        }
        const unknown = await v.node(NOWHERE);
        for (const id of r.hiddenRecords.slice(0, 4)) {
          const res = await v.node(id);
          check(checks, res.status === unknown.status && res.status >= 400, `${caller} node ${id} answers like a missing record (${res.status} vs ${unknown.status})`);
          check(checks, leakedStrings(res.body, r.hiddenStrings).length === 0, `${caller} node ${id}: no hidden labels in the refusal`);
        }
        const unknownEdge = await v.edge("E-999");
        const hiddenEdges = johnEdges.filter((e) => r.hiddenRecords.includes(e.from) || r.hiddenRecords.includes(e.to)).slice(0, 4);
        for (const e of hiddenEdges) {
          const res = await v.edge(e.id);
          check(checks, res.status === unknownEdge.status && res.status >= 400, `${caller} edge ${e.id} (${e.from}~${e.to}) answers like a missing edge (${res.status} vs ${unknownEdge.status})`);
        }
      }
      return { checks };
    },
  },
  {
    id: "MT-51",
    phase: 3,
    threat: "8.4.2 activity and count leaks",
    title: "Restricted callers' activity feeds and counts hold no hidden records and count none",
    needs: ["activity", "counts"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const checks = [];
      const range = { from: "2026-09-28", to: "2026-10-04" };
      for (const [caller, r] of Object.entries(g9(ctx).restricted)) {
        const v = p3(target, caller);
        const feed = await v.activity({});
        check(checks, feed.status === 200, `${caller} activity answers 200 (got ${feed.status})`);
        check(checks, leakedIds(feed.body, r.hiddenRecords).length === 0, `${caller} activity: no hidden record ids (${JSON.stringify(leakedIds(feed.body, r.hiddenRecords))})`);
        check(checks, leakedStrings(feed.body, r.hiddenStrings).length === 0, `${caller} activity: no hidden labels (${JSON.stringify(leakedStrings(feed.body, r.hiddenStrings))})`);
        for (const agent of contributors(ctx)) {
          const one = await v.activity({ agent });
          check(checks, leakedIds(one.body, r.hiddenRecords).length === 0, `${caller} activity of ${agent}: no hidden records`);
        }
        const counts = await v.counts(range);
        check(checks, counts.status === 200, `${caller} counts answer 200 (got ${counts.status})`);
        for (const agent of contributors(ctx)) {
          const want = expectedCount(ctx, caller, agent, range);
          check(checks, countOf(counts, agent) === want, `${caller} count for ${agent} includes only readable records: ${want} (got ${countOf(counts, agent)})`);
        }
        check(checks, leakedStrings(counts.body, r.hiddenStrings).length === 0, `${caller} counts: no hidden labels`);
      }
      return { checks };
    },
  },
  {
    id: "MT-52",
    phase: 3,
    threat: "8.4.3 empty and restricted views",
    title: "No-grant callers and filters with no match get a clean empty 200 in every view",
    needs: ["graph", "memoryList", "activity", "counts"],
    async run(target, ctx) {
      await ensureD9(target, ctx);
      const checks = [];
      const views = async (v, f) => [
        ["graph", await v.graph(f), (res) => nodesOf(res).length + edgesOf(res).length],
        ["list", await v.list(f), (res) => itemsOf(res).length],
        ["activity", await v.activity(f.q ? {} : f), (res) => itemsOf(res).length],
        ["counts", await v.counts({ from: "2026-09-28", to: "2026-10-04" }), (res) => (res.body?.agents ?? []).reduce((n, a) => n + Number(a.contributions ?? a.count ?? 0), 0)],
      ];
      for (const [what, res, size] of await views(p3(target, "ag-quill-syn"), {})) {
        check(checks, res.status === 200, `no-grant caller: ${what} answers 200 (got ${res.status})`);
        check(checks, size(res) === 0, `no-grant caller: ${what} is empty (size ${size(res)})`);
      }
      const john = p3(target, "hu-john-syn");
      for (const [f, what] of [
        [{ q: "no-such-term-zz9" }, "search with no match"],
        [{ agent: "ag-quill-syn" }, "an agent with no contributions"],
      ]) {
        const g = await john.graph(f);
        const l = await john.list(f);
        check(checks, g.status === 200 && nodesOf(g).length === 0, `John, ${what}: graph is an empty 200 (got ${g.status}, ${nodesOf(g).length} nodes)`);
        check(checks, l.status === 200 && itemsOf(l).length === 0, `John, ${what}: list is an empty 200 (got ${l.status})`);
      }
      const a = await john.activity({ agent: "ag-quill-syn" });
      check(checks, a.status === 200 && itemsOf(a).length === 0, `John, agent with no contributions: activity is an empty 200 (got ${a.status})`);
      return { checks };
    },
  },
];
