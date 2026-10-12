// Helpers shared by the phase 1 and phase 2 tests.

export function client(target, identityId, extraHeaders = {}) {
  // A null token means the caller authenticates without one (the local board on the gsam target).
  const token = target.tokenFor(identityId);
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  return {
    recall: (body, h = {}) => target.recall({ ...headers, ...h }, body),
    contribute: (body, h = {}) => target.contribute({ ...headers, ...h }, body),
    // Phase 2 calls. Targets without them make the test inconclusive (see needs()).
    review: (recordId, body) => target.review({ ...headers }, recordId, body),
    supersede: (recordId, body) => target.supersede({ ...headers }, recordId, body),
    remove: (recordId) => target.remove({ ...headers }, recordId),
    get: (recordId) => target.getRecord({ ...headers }, recordId),
    createDirective: (body) => target.createDirective({ ...headers }, body),
    stewardRun: (body) => target.stewardRun({ ...headers }, body),
  };
}

export function check(checks, ok, label) {
  checks.push({ ok: Boolean(ok), label });
}

export function verdict(checks) {
  return checks.every((c) => c.ok) ? "pass" : "fail";
}

export function resultIds(res) {
  return (res.body?.results ?? []).map((r) => r.id);
}

// Zero results only proves isolation when the recall really searched. A
// gateway that answers "memory unavailable" returns nothing for everyone.
export function searched(res) {
  return res.status === 200 && res.body?.available !== false;
}

export function denied(res) {
  return res.status === 401 || res.status === 403 || res.status === 404;
}

export async function withAudit(target, fn) {
  const cursor = await target.auditCursor();
  const out = await fn();
  const audit = await target.auditSince(cursor);
  return { out, audit };
}

export function auditHas(audit, match) {
  return audit.some((row) => Object.entries(match).every(([k, v]) => (typeof v === "function" ? v(row[k], row) : row[k] === v)));
}

export function leaked(haystack, needles) {
  const s = JSON.stringify(haystack);
  return needles.filter((n) => s.includes(n));
}
