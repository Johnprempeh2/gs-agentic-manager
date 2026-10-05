// Phase 3 read views for the test double (GRE-866, plan GRE-646 section 8):
// graph, list, node and edge detail, activity feed, per-agent counts, and the
// ground truth the tests compare them with. Shapes are the runner's
// normalised contract; the gsam target maps the gateway's fields onto it.

export const PHASE3_FAULTS = {
  "graph-fabricated-edge": "Graph draws an inferred link between records that share entity words across scopes, with no stored row (R-902 ~ R-907)",
  "inferred-as-explicit": "Inferred associations are labelled explicit",
  "causal-label": "Inferred association labels say one memory causes the other",
  "graph-ignores-grants": "Graph and list return records from every scope",
  "dangling-edges": "Edges are kept when one end is outside the view (filtered out or hidden)",
  "edges-ignore-grants": "Edges come from a query with no scope check, so hidden edges reach a restricted caller",
  "counts-include-hidden": "Per-agent counts include records the caller may not read",
  "activity-ignores-grants": "Activity feed returns records from every scope",
  "count-drilldown-mismatch": "Counts leave out superseded records that the drill-down lists",
  "roles-merged": "After review, the reviewer replaces the contributor and the review events are dropped",
  "extraction-unlinked": "Extracted facts lose their contributor",
  "list-graph-mismatch": "List view ignores the status filter",
  "restricted-errors": "Empty and restricted views answer 403 instead of an empty 200",
  "hidden-id-distinguishable": "A hidden node or edge answers 403, an unknown one 404",
  "status-drift": "Graph shows 'pending_review' instead of the phase 2 'unreviewed'",
  "nav-no-source": "Node detail drops the source",
  "score-field": "Counts carry a score and a rank",
  "activity-no-history": "Activity items drop the review, edit and supersession history",
};

const NOT_FOUND = { status: 404, body: { error: "not_found" } };
const STATUS = { proposal: "unreviewed", observation: "unreviewed", unreviewed: "unreviewed", approved: "approved", disputed: "disputed", superseded: "superseded" };
const MEANING = {
  supports: "Stated: supports",
  contradicts: "Stated: contradicts",
  refines: "Stated: refines",
  depends_on: "Stated: depends on",
  same_subject: "Stated: same subject",
  supersedes: "Stated: replaces (supersession)",
};

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function day(iso) {
  return String(iso).slice(0, 10);
}

/** `state`: the double's internal stores. Returns target methods. */
export function phase3Views({ on, records, byName, events, relationships, engine, readable, authenticate, lower }) {
  const p3status = (rec) => (on.has("status-drift") && STATUS[rec.status] === "unreviewed" ? "pending_review" : STATUS[rec.status] ?? rec.status);

  function liveRecords() {
    return records.filter((r) => r.status !== "deleted");
  }

  function visibleFor(actor, { ignoreGrants = false } = {}) {
    const scopes = new Set(readable(actor));
    return liveRecords().filter((r) => ignoreGrants || scopes.has(r.scope));
  }

  /** Open possible conflicts from the contribution check: the only inferred links the gateway stores (GRE-864). */
  function conflictRows() {
    return relationships.filter((r) => r.type === "conflicts_with").map((r) => ({ a: r.from, b: r.to }));
  }

  function inferredPairs() {
    const out = conflictRows();
    if (!on.has("graph-fabricated-edge")) return out;
    // The fault: links made up from shared entity words, in any scope, with nothing stored.
    const live = liveRecords();
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const ea = (live[i].entities ?? []).map(norm);
        const eb = (live[j].entities ?? []).map(norm);
        if (ea.some((e) => eb.some((f) => f !== e && (f.includes(e) || e.includes(f))))) out.push({ a: live[i].id, b: live[j].id });
      }
    }
    return out;
  }

  function allEdges() {
    const explicit = relationships
      .filter((r) => r.type !== "conflicts_with")
      .map((r, i) => ({
        id: r.id ?? `X-${i + 1}`,
        from: r.from,
        to: r.to,
        kind: "explicit",
        type: r.type,
        author: r.author,
        source: r.source ?? null,
        label: MEANING[r.type] ?? r.type,
        meaning: MEANING[r.type] ?? r.type,
        note: r.note ?? null,
      }));
    const inferred = inferredPairs().map((p) => ({
      id: `cfl:${p.a}~${p.b}`,
      from: p.a,
      to: p.b,
      kind: on.has("inferred-as-explicit") ? "explicit" : "inferred",
      type: "possible_conflict",
      author: "system",
      source: { kind: null, id: null },
      label: on.has("causal-label") ? `${p.a} causes ${p.b}` : "Possible conflict (pattern check)",
      meaning: on.has("causal-label")
        ? "One memory led to the other"
        : "The conflict check matched the same topic in both. It does not mean one caused or confirms the other.",
    }));
    return [...explicit, ...inferred];
  }

  function matches(rec, f, { ignoreStatus = false } = {}) {
    if (f.agent && rec.contributor !== f.agent) return false;
    if (f.scope && rec.scope !== f.scope) return false;
    if (!ignoreStatus && f.status && STATUS[rec.status] !== f.status) return false;
    if (f.q) {
      const hay = [rec.title, rec.text, ...(rec.entities ?? []), rec.source?.id].map(norm).join(" ");
      if (!hay.includes(norm(f.q))) return false;
    }
    return true;
  }

  function nodeOf(rec) {
    return { id: rec.id, label: rec.title ?? String(rec.text).slice(0, 60), scope: rec.scope, status: p3status(rec), contributor: rec.contributor, createdAt: rec.at };
  }

  function emptyOr(res, empty) {
    if (empty && on.has("restricted-errors")) return { status: 403, body: { error: "forbidden" } };
    return res;
  }

  function nodesAndEdges(actor, f, opts = {}) {
    const visible = visibleFor(actor, { ignoreGrants: on.has("graph-ignores-grants") });
    const nodes = visible.filter((r) => matches(r, f, opts));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = on.has("edges-ignore-grants")
      ? allEdges()
      : allEdges().filter((e) => (on.has("dangling-edges") ? ids.has(e.from) || ids.has(e.to) : ids.has(e.from) && ids.has(e.to)));
    return { nodes, edges };
  }

  function historyOf(rec) {
    return events.filter((e) => e.key === rec.key).map((e) => ({ action: e.type, actor: e.actor, at: e.at, related: e.by ?? e.replaces ?? null, reason: e.reason ?? null }));
  }

  function provenance(rec) {
    const reviews = historyOf(rec).filter((e) => e.action !== "contributed");
    const facts = engine.facts.filter((f) => f.recordKey === rec.key);
    const extraction = facts.map((f) => ({ factId: f.factId, engineUnitId: f.engineUnitId, recordId: rec.id, contributor: on.has("extraction-unlinked") ? null : f.contributor, actor: "engine" }));
    if (on.has("roles-merged") && rec.approval) return { contributor: { actor: rec.approval.approver, at: rec.at }, reviewers: [], extraction };
    return { contributor: { actor: rec.contributor, at: rec.at }, reviewers: reviews, extraction };
  }

  function hiddenOr404(actor, exists) {
    if (exists && on.has("hidden-id-distinguishable")) return { status: 403, body: { error: "forbidden" } };
    return NOT_FOUND;
  }

  function activityItems(actor, f, { ignoreGrants = false, skipSuperseded = false } = {}) {
    return visibleFor(actor, { ignoreGrants })
      .filter((r) => (!f.agent || r.contributor === f.agent) && (!f.scope || r.scope === f.scope) && (!f.from || day(r.at) >= f.from) && (!f.to || day(r.at) <= f.to))
      .filter((r) => !skipSuperseded || r.status !== "superseded")
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map((r) => ({
        recordId: r.id,
        nodeId: r.id,
        contributor: r.contributor,
        at: r.at,
        scope: r.scope,
        title: r.title ?? null,
        origin: r.source ?? null,
        source: r.source ?? null,
        status: p3status(r),
        history: on.has("activity-no-history") ? [] : historyOf(r),
      }));
  }

  return {
    async graph(headers, f = {}) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const { nodes, edges } = nodesAndEdges(auth.actor, f);
      return emptyOr({ status: 200, body: { nodes: nodes.map(nodeOf), edges } }, nodes.length === 0);
    },
    async memoryList(headers, f = {}) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const { nodes } = nodesAndEdges(auth.actor, f, { ignoreStatus: on.has("list-graph-mismatch") });
      return emptyOr({ status: 200, body: { items: nodes.map(nodeOf) } }, nodes.length === 0);
    },
    async node(headers, name) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const rec = byName.get(name);
      const visible = rec && rec.status !== "deleted" && (on.has("graph-ignores-grants") || readable(auth.actor).includes(rec.scope));
      if (!visible) return hiddenOr404(auth.actor, Boolean(rec));
      const { edges } = nodesAndEdges(auth.actor, {});
      return {
        status: 200,
        body: {
          record: { id: rec.id, scope: rec.scope, status: p3status(rec), title: rec.title ?? null, content: rec.text },
          status: p3status(rec),
          source: on.has("nav-no-source") ? null : rec.source ?? null,
          contributor: provenance(rec).contributor.actor,
          provenance: provenance(rec),
          edges: edges.filter((e) => e.from === rec.id || e.to === rec.id).map((e) => e.id),
          links: { activity: { agent: rec.contributor, recordId: rec.id }, graph: { nodeId: rec.id } },
        },
      };
    },
    async edge(headers, id) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const all = allEdges();
      const exists = all.find((e) => e.id === id);
      const { edges } = nodesAndEdges(auth.actor, {});
      const found = edges.find((e) => e.id === id);
      if (!found) return hiddenOr404(auth.actor, Boolean(exists));
      return { status: 200, body: found };
    },
    async activity(headers, f = {}) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const items = activityItems(auth.actor, f, { ignoreGrants: on.has("activity-ignores-grants") });
      return emptyOr({ status: 200, body: { items } }, items.length === 0);
    },
    async counts(headers, f = {}) {
      const auth = authenticate(lower(headers));
      if (auth.error) return auth.error;
      const items = activityItems(auth.actor, { from: f.from, to: f.to }, { ignoreGrants: on.has("counts-include-hidden"), skipSuperseded: on.has("count-drilldown-mismatch") });
      const by = new Map();
      for (const it of items) by.set(it.contributor, (by.get(it.contributor) ?? 0) + 1);
      const agents = [...by].map(([agent, contributions], i) => ({ agent, contributions, ...(on.has("score-field") ? { score: contributions * 10, rank: i + 1 } : {}) }));
      return emptyOr({ status: 200, body: { from: f.from ?? null, to: f.to ?? null, label: "Contribution activity, not quality", agents } }, agents.length === 0);
    },
    // Ground truth, read the way an admin reads the stores.
    async relationshipRows() {
      return relationships.filter((r) => r.type !== "conflicts_with").map((r) => ({ id: r.id ?? null, from: r.from, to: r.to, type: r.type, author: r.author }));
    },
    async inferredRows() {
      return { available: true, pairs: conflictRows() };
    },
    async extractedFacts() {
      return { available: true, facts: engine.facts.map((f) => ({ factId: f.factId, recordId: f.recordId, contributor: f.contributor })) };
    },
  };
}
