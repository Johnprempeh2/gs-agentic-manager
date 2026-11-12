// Staging holds the edits (John, 7 Nov): the website team agent puts main on staging (gre3833) with
// `npm run deploy:staging`. GSAM only watches and hands the work over on a task, so the Netlify token never
// leaves the agent's deploy environment (and never goes on GitHub). One open task at a time; a failure stays on
// that task, and the watch raises no new one until it is closed.
// Credits (John, 12 Nov): each staging upload is a 15-credit production deploy, so code merges no longer go
// straight to staging. A Publish (a content release waiting) still goes at once; code alone goes at most twice a
// day, in the 07:00 and 15:00 UK windows; a person can always ask the team for one. And never twice for the same
// commit and release: on 8 Nov the watch raised 109 tasks and staging took commit 5a57691 75 times.
import { and, desc, eq, like, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues, websiteSite } from "@greatstone/db";
import { logger } from "../../middleware/logger.js";
import { createGitRemoteAuthProvider, GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../git-credentials.js";
import { issueService } from "../issues.js";
import { secretService } from "../secrets.js";
import { contentPointer, lastGuardedCommit, STAGING_DOMAIN, STAGING_NETLIFY_SITE_ID, WEBSITE_PROJECT_ID, WEBSITE_REPO } from "./deploy-changes.js";
import { websiteTeamAgent } from "./pending-alert.js";
import { reportedRelease } from "./publish.js";

export const STAGING_WATCH_TITLE = "Put website main on staging";
export const STAGING_WATCH_ALERT_TITLE = "Staging watch cannot reach";
/** Sweeps in a row that must fail before the team gets a task: one blip is not worth a task. */
export const STAGING_WATCH_FAILURES_BEFORE_ALERT = 3;
/** Each GitHub or Netlify call's own limit: a page of staging's deploy list takes about 6 s (GRE-5060, GRE-5062). */
export const STAGING_WATCH_CALL_TIMEOUT_MS = 20_000;
/**
 * Staging's deploy list is read 10 at a time, newest first, up to the last 100 (GRE-5062). Each deploy record is
 * about 27 KB and grows with every deploy: one page of 100 took 39 s, one of 10 takes about 6 s.
 */
export const STAGING_DEPLOYS_PER_PAGE = 10;
export const STAGING_DEPLOYS_CAP = 100;
const CHECK_EVERY_MS = 2 * 60_000;
/** UK hours at which code merges (with no content waiting) may go to staging: at most one task per window. */
export const STAGING_WINDOWS_UK = [7, 15] as const;

/** The start of the latest UK staging window at or before `now`. */
export function latestStagingWindow(now: Date): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, Number(p.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // ponytail: uses now's UK offset for the window; off by an hour only between midnight and 02:00 on a clock-change day.
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  const hour = [...STAGING_WINDOWS_UK].reverse().find((h) => parts.hour >= h);
  const start = hour === undefined
    ? Date.UTC(parts.year, parts.month - 1, parts.day - 1, STAGING_WINDOWS_UK[STAGING_WINDOWS_UK.length - 1])
    : Date.UTC(parts.year, parts.month - 1, parts.day, hour);
  return new Date(start - offset);
}

export function stagingWatchTaskTitle(sha: string, content: number | null) {
  return `${STAGING_WATCH_TITLE} (${sha.slice(0, 7)}${content === null ? "" : `, content release ${content}`})`;
}

export interface StagingWatchDeps {
  mainCommit(): Promise<string>;
  stagedCommit(): Promise<string | null>;
  /** The watch's task that is not done or cancelled, if any. */
  openTask(): Promise<{ identifier: string | null } | null>;
  /** Whether a watch task with exactly this title was ever raised, in any status. */
  taskExists(title: string): Promise<boolean>;
  /** When the newest watch task was raised, or null. */
  lastTaskAt(): Promise<Date | null>;
  /** The content release staging's store points at (`current`, which GSAM's publish writes), or null. */
  storeRelease(): Promise<number | null>;
  /** The content release staging's pages were built with (their gsam-release mark), or null when they name none. */
  builtRelease(): Promise<number | null>;
  createTask(sha: string, staged: string | null, content: number | null): Promise<void>;
  /** The open "cannot reach" task, if any. */
  openAlert(): Promise<{ id: string } | null>;
  createAlert(service: string, reason: string): Promise<void>;
  closeAlert(id: string): Promise<void>;
}

/** Which service a failed check names, so the alert says what to fix. Messages carry no secrets. */
export class StagingWatchError extends Error {
  constructor(readonly service: "GitHub" | "Netlify", message: string) {
    super(message);
  }
}

/**
 * One GitHub or Netlify call, tried once more when it times out or the network drops it (GRE-5060). What still
 * fails becomes a StagingWatchError naming the service and step, so the alert says which one to look at, never
 * "GitHub or Netlify". A service's own answer (a StagingWatchError, such as a 401) is not retried.
 */
export async function watchCall<T>(
  service: StagingWatchError["service"],
  step: string,
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs = STAGING_WATCH_CALL_TIMEOUT_MS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(AbortSignal.timeout(timeoutMs));
    } catch (err) {
      if (err instanceof StagingWatchError) throw err;
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // fetch reports a dropped connection or failed lookup as a TypeError ("fetch failed").
      if (attempt < 2 && (timedOut || err instanceof TypeError)) continue;
      const tries = attempt === 1 ? "" : `, tried ${attempt} times`;
      throw new StagingWatchError(service, timedOut
        ? `${service}: ${step} timed out after ${timeoutMs / 1000} s${tries}`
        : `${service}: ${step} failed${tries}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The commit of staging's newest guarded deploy, read page by page until found, the list ends, or the cap. */
export async function pagedStagedCommit(readPage: (page: number) => Promise<Parameters<typeof lastGuardedCommit>[0]>) {
  for (let page = 1; page <= STAGING_DEPLOYS_CAP / STAGING_DEPLOYS_PER_PAGE; page += 1) {
    const deploys = await readPage(page);
    const sha = lastGuardedCommit(deploys, "staging");
    if (sha) return sha;
    if (deploys.length < STAGING_DEPLOYS_PER_PAGE) break;
  }
  return null;
}

/** One sweep: the check, then the alert after 3 failures in a row (one task), closed by the next success. */
export async function stagingWatchSweep(deps: StagingWatchDeps, state: { failures: number }, now = new Date()) {
  try {
    const result = await stagingWatchTick(deps, now);
    state.failures = 0;
    const alert = await deps.openAlert();
    if (alert) await deps.closeAlert(alert.id);
    return result;
  } catch (err) {
    state.failures += 1;
    if (state.failures >= STAGING_WATCH_FAILURES_BEFORE_ALERT && !(await deps.openAlert())) {
      const service = err instanceof StagingWatchError ? err.service : "GitHub or Netlify";
      await deps.createAlert(service, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export async function stagingWatchTick(deps: StagingWatchDeps, now = new Date()) {
  const [main, staged, store, built] = await Promise.all([deps.mainCommit(), deps.stagedCommit(), deps.storeRelease(), deps.builtRelease()]);
  // Content waits while staging's pages were not built with the release its store holds (GRE-4664). Both come from
  // staging itself, so a finished deploy is its own record and a newer publish names the newer release.
  const content = store !== null && store !== built ? store : null;
  if (main === staged && content === null) return "current" as const;
  if (await deps.openTask()) return "busy" as const;
  // The same commit and release never get a second task, whatever became of the first (8 Nov: 109 tasks).
  if (await deps.taskExists(stagingWatchTaskTitle(main, content))) return "duplicate" as const;
  // Code alone waits for the next UK window; a Publish (content waiting) goes now.
  if (content === null) {
    const last = await deps.lastTaskAt();
    if (last && last >= latestStagingWindow(now)) return "waiting" as const;
  }
  await deps.createTask(main, staged, content);
  return "created" as const;
}

export function stagingWatchTaskDescription(sha: string, staged: string | null, content: number | null = null) {
  const env = content === null ? "" : `GSAM_CONTENT_RELEASE=${content} `;
  return [
    `Website main is at \`${sha}\`; staging (gre3833-next-db-staging) holds \`${staged ?? "nothing GSAM can read"}\`.`,
    ...(content === null ? [] : [`GSAM content release ${content} was published to staging's store and waits for a staging rebuild (page edits from the Website module).`]),
    "",
    `In a clean checkout of ${WEBSITE_REPO} detached at origin main, run \`${env}npm run deploy:staging\` with GSAM_TASK_ID set to this task. No card is needed and it never touches the public site.`,
    "Done when it succeeds. If it fails, mark this task blocked with the error: the watch raises no new task while this one is open, so the failure stays in sight.",
  ].join("\n");
}

/** The watch for the company that owns the Greatstone website, wired to GitHub, Netlify and tasks. */
function defaultDeps(db: Db, site: typeof websiteSite.$inferSelect): StagingWatchDeps {
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  let netlifyToken: Promise<string> | null = null;
  const readNetlifyToken = () => {
    if (!site.netlifyTokenSecretId) throw new StagingWatchError("Netlify", "the website site has no Netlify token");
    netlifyToken ??= secretService(db).resolveSecretValue(site.companyId, site.netlifyTokenSecretId, "latest", {
      accessContext: { consumerType: "system", consumerId: `website-staging-watch:${site.id}`, configPath: "netlify.token", actorType: "system" },
    });
    return netlifyToken;
  };
  return {
    async mainCommit() {
      const auth = await createGitRemoteAuthProvider(db, site.companyId, { projectId: WEBSITE_PROJECT_ID, operation: "inspect" })(`https://github.com/${WEBSITE_REPO}.git`);
      const token = auth?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY];
      if (!token) throw new StagingWatchError("GitHub", "no GitHub token for the Website project (its GitHub grant, or a GITHUB_TOKEN company secret)");
      return watchCall("GitHub", "website main commit", async (signal) => {
        const res = await fetch(`https://api.github.com/repos/${WEBSITE_REPO}/commits/main`, {
          headers: { ...headers(token), accept: "application/vnd.github+json", "user-agent": "GS Agentic Manager" }, signal,
        });
        if (!res.ok) throw new StagingWatchError("GitHub", `GitHub answered ${res.status} for ${WEBSITE_REPO} main`);
        return ((await res.json()) as { sha: string }).sha;
      });
    },
    async stagedCommit() {
      const token = await readNetlifyToken();
      // Each page is its own call, with its own 20 s limit and retry.
      return pagedStagedCommit((page) => watchCall("Netlify", `staging deploy list page ${page}`, async (signal) => {
        const url = `https://api.netlify.com/api/v1/sites/${STAGING_NETLIFY_SITE_ID}/deploys?per_page=${STAGING_DEPLOYS_PER_PAGE}&page=${page}`;
        const res = await fetch(url, { headers: headers(token), signal });
        if (!res.ok) throw new StagingWatchError("Netlify", `Netlify answered ${res.status} for the staging site's deploys (check the website site's Netlify token)`);
        return res.json();
      }));
    },
    async openTask() {
      const [row] = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, site.companyId), like(issues.title, `${STAGING_WATCH_TITLE}%`), notInArray(issues.status, ["done", "cancelled"])))
        .limit(1);
      return row ?? null;
    },
    async taskExists(title) {
      const [row] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, site.companyId), eq(issues.title, title)))
        .limit(1);
      return Boolean(row);
    },
    async lastTaskAt() {
      const [row] = await db
        .select({ createdAt: issues.createdAt })
        .from(issues)
        .where(and(eq(issues.companyId, site.companyId), like(issues.title, `${STAGING_WATCH_TITLE}%`)))
        .orderBy(desc(issues.createdAt))
        .limit(1);
      return row?.createdAt ?? null;
    },
    async openAlert() {
      const [row] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, site.companyId), like(issues.title, `${STAGING_WATCH_ALERT_TITLE}%`), notInArray(issues.status, ["done", "cancelled"])))
        .limit(1);
      return row ?? null;
    },
    async createAlert(service, reason) {
      const team = await websiteTeamAgent(db, site.companyId, site.propertyId);
      await issueService(db).create(site.companyId, {
        title: `${STAGING_WATCH_ALERT_TITLE} ${service}`,
        description: [
          `The staging watch has failed ${STAGING_WATCH_FAILURES_BEFORE_ALERT} sweeps in a row, so merges to website main are not reaching staging.`,
          "",
          `- Service: ${service}`,
          `- Last error: ${reason}`,
          "",
          "Fix the token or connection named above (the website site's Netlify token in its settings, or the Website project's GitHub grant). GSAM closes this task by itself on the next sweep that works.",
        ].join("\n"),
        status: "todo",
        priority: "high",
        assigneeAgentId: team.id,
        projectId: team.projectId ?? WEBSITE_PROJECT_ID,
      });
    },
    async closeAlert(id) {
      await issueService(db).update(id, { status: "done" });
    },
    async storeRelease() {
      const token = await readNetlifyToken();
      // contentPointer sets its own 15 s signal; this fetch swaps in the watch's, so one limit and one retry apply.
      return watchCall("Netlify", "staging content store", (signal) =>
        contentPointer(STAGING_NETLIFY_SITE_ID, site.blobsStoreName, token, (url, init) => fetch(url, { ...init, signal })));
    },
    async builtRelease() {
      return watchCall("Netlify", "staging home page", async (signal) => {
        const res = await fetch(`https://${STAGING_DOMAIN}/`, { cache: "no-store", headers: { "user-agent": "GS Agentic Manager" }, signal });
        if (!res.ok) throw new StagingWatchError("Netlify", `staging's home page answered ${res.status}`);
        // The page's meta mark is baked in at build; a release header may come from the store at request time (as
        // /_release does), so it is left out: only the mark says what staging was built with.
        const seen = Number(reportedRelease({ status: res.status, headers: new Headers(), body: await res.text() }) ?? NaN);
        return Number.isInteger(seen) ? seen : null;
      });
    },
    async createTask(sha, staged, content) {
      const team = await websiteTeamAgent(db, site.companyId, site.propertyId);
      await issueService(db).create(site.companyId, {
        title: stagingWatchTaskTitle(sha, content),
        description: stagingWatchTaskDescription(sha, staged, content),
        status: "todo",
        priority: "high",
        assigneeAgentId: team.id,
        projectId: team.projectId ?? WEBSITE_PROJECT_ID,
      });
    },
  };
}

let lastCheck = 0;
const sweepState = { failures: 0 };

/** Runs with the execution-control sweeps; checks GitHub and Netlify at most every two minutes. */
export async function runStagingWatch(db: Db, now = Date.now()) {
  if (now - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = now;
  // The public site's row: its token reads both sites, and its property names the website team.
  const [site] = await db.select().from(websiteSite).where(eq(websiteSite.netlifySiteId, "3b1e97e6-e184-4251-badd-deed532be3ab")).limit(1);
  if (!site || site.archivedAt) return;
  try {
    const result = await stagingWatchSweep(defaultDeps(db, site), sweepState, new Date(now));
    if (result === "created") logger.info({ siteId: site.id }, "website staging watch handed main to the website team");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "website staging watch could not check");
  }
}
