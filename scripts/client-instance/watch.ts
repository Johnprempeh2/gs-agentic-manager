// Host watch signals for one client instance (GRE-666). Pure helpers, tested
// without a server; client-instance.ts gathers the inputs and sends alerts.
//
// Each signal is { key, ok, detail } with numbers and states only: no client
// names, no tokens. The same list is what the health check-in (GRE-144) will
// send, so keep keys stable.

import { isAiAuthRequiredErrorCode } from "../../packages/shared/src/ai-connections.js";

export interface WatchSignal {
  key: string;
  ok: boolean;
  detail: string;
}

/** Below this the app holds new runs (GRE-207), so the watch alerts at the same floors. */
export const DISK_MIN_FREE_BYTES = 20 * 1024 ** 3;
export const MEMORY_MIN_AVAILABLE_BYTES = 2048 * 1024 ** 2;
/** Alert this long before a known AI token expiry (doc "Client hosting options", section 7). */
export const AI_EXPIRY_ALERT_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed-auth run this recent is still news. The alert itself is sent once per change (below). */
export const AI_FAILED_AUTH_WINDOW_MS = 60 * 60 * 1000;
/** A failure that does not change is mailed again after this long. */
export const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

/** A signal from `status`-style lines: it fails when any line is a WARNING. */
export function linesSignal(key: string, lines: string[]): WatchSignal {
  const warning = lines.find((line) => line.startsWith("WARNING"));
  return { key, ok: !warning, detail: warning ?? lines[0] ?? "" };
}

export function diskSignal(freeBytes: number, minBytes = DISK_MIN_FREE_BYTES): WatchSignal {
  return { key: "disk", ok: freeBytes >= minBytes, detail: `${gb(freeBytes)} free (floor ${gb(minBytes)})` };
}

export function memorySignal(availableBytes: number, minBytes = MEMORY_MIN_AVAILABLE_BYTES): WatchSignal {
  return { key: "memory", ok: availableBytes >= minBytes, detail: `${mb(availableBytes)} available (floor ${mb(minBytes)})` };
}

/** MemAvailable from /proc/meminfo in bytes (Linux), or null. os.freemem() leaves out the page cache. */
export function memAvailableFromMeminfo(text: string): number | null {
  const match = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}

export interface AiConnectionView {
  id: string;
  provider?: string;
  status: string;
  credential?: { expiresAt: string | null };
}

export interface RunView {
  id: string;
  status: string;
  errorCode?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
}

const shortId = (id: string) => id.slice(0, 8);

/**
 * AI access as the operator log-in sees it (GRE-15): every visible connection
 * is `connected` and no known expiry is under 7 days; no run refused for auth
 * in the last hour. The run check also covers connections the operator cannot
 * list (a client's personal log-in).
 */
export function aiSignals(companyId: string, connections: AiConnectionView[], runs: RunView[], now = Date.now()): WatchSignal[] {
  const company = shortId(companyId);
  const problems: string[] = [];
  for (const c of connections) {
    const label = `${c.provider ?? "ai"} connection ${shortId(c.id)}`;
    if (c.status !== "connected") problems.push(`${label} is ${c.status.replace("_", " ")}`);
    const expiresAt = c.credential?.expiresAt ? Date.parse(c.credential.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt - now < AI_EXPIRY_ALERT_MS) {
      problems.push(expiresAt <= now ? `${label} token expired ${c.credential!.expiresAt}` : `${label} token expires ${c.credential!.expiresAt} (under 7 days)`);
    }
  }
  const connectionSignal: WatchSignal = {
    key: `ai-connections:${company}`,
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : connections.length ? `${connections.length} connected` : "no AI connection visible to the operator",
  };
  const refused = runs.filter((run) => {
    if (run.status !== "failed" || !isAiAuthRequiredErrorCode(run.errorCode)) return false;
    const at = Date.parse(run.finishedAt ?? run.createdAt ?? "");
    return Number.isFinite(at) && now - at <= AI_FAILED_AUTH_WINDOW_MS;
  });
  const runSignal: WatchSignal = {
    key: `ai-failed-auth:${company}`,
    ok: refused.length === 0,
    detail: refused.length
      ? `${refused.length} run(s) refused by the AI provider in the last hour (${refused.map((r) => `${shortId(r.id)} ${r.errorCode}`).join(", ")})`
      : "no run refused for auth in the last hour",
  };
  return [connectionSignal, runSignal];
}

export interface AlertState {
  /** Keys that failed at the last alert, sorted. Empty after a recovery mail. */
  failing: string[];
  alertedAt: string | null;
}

export type AlertDecision = { send: false } | { send: true; kind: "failing" | "recovered" };

/**
 * Mail when the set of failing checks changes, again every 24 h while it
 * stays failing, and once when everything is back. Runs every 5 minutes, so
 * without this one failure would send 288 mails a day.
 */
export function decideAlert(previous: AlertState, failing: string[], now = Date.now()): AlertDecision {
  const current = [...failing].sort();
  const same = current.length === previous.failing.length && current.every((key, i) => key === previous.failing[i]);
  if (current.length === 0) return previous.failing.length > 0 ? { send: true, kind: "recovered" } : { send: false };
  if (!same) return { send: true, kind: "failing" };
  const last = previous.alertedAt ? Date.parse(previous.alertedAt) : Number.NaN;
  return !Number.isFinite(last) || now - last >= ALERT_REPEAT_MS ? { send: true, kind: "failing" } : { send: false };
}

/** Plain-text mail: subject and body. Instance code and signal lines only. */
export function alertMessage(code: string, kind: "failing" | "recovered", signals: WatchSignal[], at: string): { subject: string; body: string } {
  const failed = signals.filter((s) => !s.ok);
  const subject =
    kind === "recovered" ? `[GSAM ${code}] all checks pass again` : `[GSAM ${code}] ${failed.length} check(s) failing: ${failed.map((s) => s.key).join(", ")}`;
  const body = [
    `Instance ${code}, host watch at ${at}.`,
    "",
    ...signals.map((s) => `${s.ok ? "PASS" : "FAIL"} ${s.key}: ${s.detail}`),
    "",
    "Run-book: doc/CLIENT-INSTANCES.md, section \"Host watch\".",
  ].join("\n");
  return { subject, body };
}

export interface WatchConfig {
  /** The operator log-in's password; the watch reads AI access as that user. */
  operatorPassword: string;
  /** Dead-man check (healthchecks.io): pinged when all pass, `<url>/fail` with the report when not. */
  pingUrl: string | null;
  alertEmail: string | null;
  /** argv of a sendmail-style command that reads the mail on stdin, for example `/usr/sbin/sendmail -t`. */
  mailCommand: string[] | null;
}

/** Parse a watch config file (KEY=VALUE lines). Returns the config or the reason it is refused. */
export function parseWatchConfig(text: string): WatchConfig | { error: string } {
  const values: Record<string, string> = {};
  const allowed = new Set(["WATCH_OPERATOR_PASSWORD", "WATCH_PING_URL", "WATCH_ALERT_EMAIL", "WATCH_MAIL_COMMAND"]);
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `line ${index + 1} is not KEY=VALUE` };
    const key = line.slice(0, eq).trim();
    if (!allowed.has(key)) return { error: `${key} is not a watch setting` };
    values[key] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!values.WATCH_OPERATOR_PASSWORD) return { error: "WATCH_OPERATOR_PASSWORD is missing (the AI checks read as the operator log-in)" };
  const pingUrl = values.WATCH_PING_URL || null;
  if (pingUrl && !/^https?:\/\//.test(pingUrl)) return { error: "WATCH_PING_URL must be an http(s) URL" };
  const alertEmail = values.WATCH_ALERT_EMAIL || null;
  const mailCommand = values.WATCH_MAIL_COMMAND ? values.WATCH_MAIL_COMMAND.split(/\s+/) : null;
  if (Boolean(alertEmail) !== Boolean(mailCommand)) return { error: "set both WATCH_ALERT_EMAIL and WATCH_MAIL_COMMAND, or neither" };
  // A watch that tells no one is not an alert.
  if (!pingUrl && !alertEmail) return { error: "set WATCH_PING_URL, or WATCH_ALERT_EMAIL with WATCH_MAIL_COMMAND, or both" };
  return { operatorPassword: values.WATCH_OPERATOR_PASSWORD, pingUrl, alertEmail, mailCommand };
}
