// Staging holds the edits (John, 7 Nov): within a few minutes of any merge to website main, the
// website team agent puts main on staging (gre3833) with `npm run deploy:staging`. GSAM only
// watches and hands the work over on a task, so the Netlify token never leaves the agent's
// deploy environment (and never goes on GitHub). One open task at a time; a failure stays on
// that task, and the watch raises no new one until it is closed.
import { and, eq, like, notInArray } from "drizzle-orm";
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
/** Each GitHub or Netlify call's own limit: Netlify's staging deploy list takes 2 to 4 s and can spike past 15 s (GRE-5060). */
export const STAGING_WATCH_CALL_TIMEOUT_MS = 20_000;
const CHECK_EVERY_MS = 2 * 60_000;

export interface StagingWatchDeps {
  mainCommit(): Promise<string>;
  stagedCommit(): Promise<string | null>;
  /** The watch's task that is not done or cancelled, if any. */
  openTask(): Promise<{ identifier: string | null } | null>;
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

/** One sweep: the check, then the alert after 3 failures in a row (one task), closed by the next success. */
export async function stagingWatchSweep(deps: StagingWatchDeps, state: { failures: number }) {
  try {
    const result = await stagingWatchTick(deps);
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

export async function stagingWatchTick(deps: StagingWatchDeps) {
  const [main, staged, store, built] = await Promise.all([deps.mainCommit(), deps.stagedCommit(), deps.storeRelease(), deps.builtRelease()]);
  // Content waits while staging's pages were not built with the release its store holds (GRE-4664). Both come from
  // staging itself, so a finished deploy is its own record and a newer publish names the newer release.
  const content = store !== null && store !== built ? store : null;
  if (main === staged && content === null) return "current" as const;
  if (await deps.openTask()) return "busy" as const;
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
    "Done when it succeeds (it also rebuilds the GSAM editor). If it fails, mark this task blocked with the error: the watch raises no new task while this one is open, so the failure stays in sight.",
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
      return watchCall("Netlify", "staging deploy list", async (signal) => {
        const res = await fetch(`https://api.netlify.com/api/v1/sites/${STAGING_NETLIFY_SITE_ID}/deploys?per_page=100`, { headers: headers(token), signal });
        if (!res.ok) throw new StagingWatchError("Netlify", `Netlify answered ${res.status} for the staging site's deploys (check the website site's Netlify token)`);
        return lastGuardedCommit(await res.json(), "staging");
      });
    },
    async openTask() {
      const [row] = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, site.companyId), like(issues.title, `${STAGING_WATCH_TITLE}%`), notInArray(issues.status, ["done", "cancelled"])))
        .limit(1);
      return row ?? null;
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
        title: `${STAGING_WATCH_TITLE} (${sha.slice(0, 7)}${content === null ? "" : `, content release ${content}`})`,
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
    const result = await stagingWatchSweep(defaultDeps(db, site), sweepState);
    if (result === "created") logger.info({ siteId: site.id }, "website staging watch handed main to the website team");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "website staging watch could not check");
  }
}
