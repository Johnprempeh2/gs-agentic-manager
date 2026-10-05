const MARK = { pass: "PASS", fail: "FAIL", inconclusive: "INCONCLUSIVE" };

export function formatReport(report, { verbose = false } = {}) {
  const lines = [];
  const faults = report.faults.length ? ` (faults: ${report.faults.join(", ")})` : "";
  lines.push(`Memory phase 1 acceptance — target: ${report.target}${faults}`);
  lines.push(`Preflight: ${report.preflight.ok ? "ok" : "NOT OK"}; engine up: ${report.preflight.engineUp}; ${report.preflight.notes.join("; ")}`);
  lines.push("");
  for (const r of report.results) {
    lines.push(`${MARK[r.status].padEnd(12)} ${r.id}  ${r.title}`);
    const show = verbose || r.status !== "pass";
    for (const c of r.checks ?? []) if (show || !c.ok) lines.push(`             ${c.ok ? "ok  " : "FAIL"} ${c.label}`);
    if (r.inconclusive) lines.push(`             why: ${r.inconclusive}`);
    if (verbose) {
      if (r.auditNote) lines.push(`             audit: ${r.auditNote}`);
      for (const a of r.audit ?? []) lines.push(`             audit: ${formatAudit(a)}`);
    }
  }
  const count = (s) => report.results.filter((r) => r.status === s).length;
  lines.push("");
  lines.push(`${count("pass")} passed, ${count("fail")} failed, ${count("inconclusive")} inconclusive, of ${report.results.length}`);
  return lines.join("\n");
}

function formatAudit(a) {
  const scopes = Array.isArray(a.scopes) ? a.scopes.join("|") : "";
  return [a.actor, a.op, a.decision, scopes && `scopes=${scopes}`, a.requestedScope && `requested=${a.requestedScope}`, a.reason && `reason=${a.reason}`]
    .filter(Boolean)
    .join(" ");
}
