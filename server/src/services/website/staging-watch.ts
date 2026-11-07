// Staging holds the edits (John, 7 Nov): within a few minutes of any merge to website main, the
// website team agent puts main on staging (gre3833) with `npm run deploy:staging`. GSAM only
// watches and hands the work over on a task, so the Netlify token never leaves the agent's
// deploy environment (and never goes on GitHub). One open task at a time; a failure stays on
// that task, and the watch raises no new one until it is closed.
import { and, desc, eq, inArray, like, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues, websiteRelease, websiteSite } from "@greatstone/db";
import { logger } from "../../middleware/logger.js";
import { createGitRemoteAuthProvider, GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../git-credentials.js";
import { issueService } from "../issues.js";
import { secretService } from "../secrets.js";
import { lastGuardedCommit, STAGING_NETLIFY_SITE_ID, WEBSITE_PROJECT_ID, WEBSITE_REPO } from "./deploy-changes.js";
import { websiteTeamAgent } from "./pending-alert.js";

export const STAGING_WATCH_TITLE = "Put website main on staging";
export const STAGING_WATCH_ALERT_TITLE = "Staging watch cannot reach";
/** Sweeps in a row that must fail before the team gets a task: one blip is not worth a task. */
export const STAGING_WATCH_FAILURES_BEFORE_ALERT = 3;
const CHECK_EVERY_MS = 2 * 60_000;

export interface StagingWatchDeps {
  mainCommit(): Promise<string>;
  stagedCommit(): Promise<string | null>;
  /** The watch's task that is not done or cancelled, if any. */
  openTask(): Promise<{ identifier: string | null } | null>;
  /** A published content release switched on staging's store that waits for a staging rebuild (its number), or null. */
  contentWaiting(): Promise<number | null>;
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
  const [main, staged, content] = await Promise.all([deps.mainCommit(), deps.stagedCommit(), deps.contentWaiting()]);
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
  return {
    async mainCommit() {
      const auth = await createGitRemoteAuthProvider(db, site.companyId, { projectId: WEBSITE_PROJECT_ID, operation: "inspect" })(`https://github.com/${WEBSITE_REPO}.git`);
      const token = auth?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY];
      if (!token) throw new StagingWatchError("GitHub", "no GitHub token for the Website project (its GitHub grant, or a GITHUB_TOKEN company secret)");
      const res = await fetch(`https://api.github.com/repos/${WEBSITE_REPO}/commits/main`, {
        headers: { ...headers(token), accept: "application/vnd.github+json", "user-agent": "GS Agentic Manager" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new StagingWatchError("GitHub", `GitHub answered ${res.status} for ${WEBSITE_REPO} main`);
      return ((await res.json()) as { sha: string }).sha;
    },
    async stagedCommit() {
      if (!site.netlifyTokenSecretId) throw new StagingWatchError("Netlify", "the website site has no Netlify token");
      const token = await secretService(db).resolveSecretValue(site.companyId, site.netlifyTokenSecretId, "latest", {
        accessContext: { consumerType: "system", consumerId: `website-staging-watch:${site.id}`, configPath: "netlify.token", actorType: "system" },
      });
      const res = await fetch(`https://api.netlify.com/api/v1/sites/${STAGING_NETLIFY_SITE_ID}/deploys?per_page=100`, {
        headers: headers(token), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new StagingWatchError("Netlify", `Netlify answered ${res.status} for the staging site's deploys (check the website site's Netlify token)`);
      return lastGuardedCommit(await res.json(), "staging");
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
    async contentWaiting() {
      const rows = await db
        .select({ number: websiteRelease.number, deploy: websiteRelease.deploy })
        .from(websiteRelease)
        .where(and(eq(websiteRelease.companyId, site.companyId), eq(websiteRelease.siteId, site.id), inArray(websiteRelease.status, ["switched", "pending"])))
        .orderBy(desc(websiteRelease.number))
        .limit(1);
      const row = rows[0];
      // A build the publish job has seen finish is a check for a person (Retry), not a new staging deploy.
      const state = (row?.deploy as { state?: string; deployId?: string | null } | null)?.state;
      return row && state !== "ready" && state !== "building" ? row.number : null;
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
