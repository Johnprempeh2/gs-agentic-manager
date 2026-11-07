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
import { lastGuardedCommit, STAGING_NETLIFY_SITE_ID, WEBSITE_PROJECT_ID, WEBSITE_REPO } from "./deploy-changes.js";
import { websiteTeamAgent } from "./pending-alert.js";

export const STAGING_WATCH_TITLE = "Put website main on staging";
const CHECK_EVERY_MS = 2 * 60_000;

export interface StagingWatchDeps {
  mainCommit(): Promise<string>;
  stagedCommit(): Promise<string | null>;
  /** The watch's task that is not done or cancelled, if any. */
  openTask(): Promise<{ identifier: string | null } | null>;
  createTask(sha: string, staged: string | null): Promise<void>;
}

export async function stagingWatchTick(deps: StagingWatchDeps) {
  const [main, staged] = await Promise.all([deps.mainCommit(), deps.stagedCommit()]);
  if (main === staged) return "current" as const;
  if (await deps.openTask()) return "busy" as const;
  await deps.createTask(main, staged);
  return "created" as const;
}

export function stagingWatchTaskDescription(sha: string, staged: string | null) {
  return [
    `Website main is at \`${sha}\`; staging (gre3833-next-db-staging) holds \`${staged ?? "nothing GSAM can read"}\`.`,
    "",
    `In a clean checkout of ${WEBSITE_REPO} detached at origin main, run \`npm run deploy:staging\` with GSAM_TASK_ID set to this task. No card is needed and it never touches the public site.`,
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
      if (!token) throw new Error("no GitHub token for the Website project");
      const res = await fetch(`https://api.github.com/repos/${WEBSITE_REPO}/commits/main`, {
        headers: { ...headers(token), accept: "application/vnd.github+json", "user-agent": "GS Agentic Manager" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      return ((await res.json()) as { sha: string }).sha;
    },
    async stagedCommit() {
      if (!site.netlifyTokenSecretId) throw new Error("no Netlify token");
      const token = await secretService(db).resolveSecretValue(site.companyId, site.netlifyTokenSecretId, "latest", {
        accessContext: { consumerType: "system", consumerId: `website-staging-watch:${site.id}`, configPath: "netlify.token", actorType: "system" },
      });
      const res = await fetch(`https://api.netlify.com/api/v1/sites/${STAGING_NETLIFY_SITE_ID}/deploys?per_page=100`, {
        headers: headers(token), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Netlify answered ${res.status}`);
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
    async createTask(sha, staged) {
      const team = await websiteTeamAgent(db, site.companyId, site.propertyId);
      await issueService(db).create(site.companyId, {
        title: `${STAGING_WATCH_TITLE} (${sha.slice(0, 7)})`,
        description: stagingWatchTaskDescription(sha, staged),
        status: "todo",
        priority: "high",
        assigneeAgentId: team.id,
        projectId: team.projectId ?? WEBSITE_PROJECT_ID,
      });
    },
  };
}

let lastCheck = 0;

/** Runs with the execution-control sweeps; checks GitHub and Netlify at most every two minutes. */
export async function runStagingWatch(db: Db, now = Date.now()) {
  if (now - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = now;
  // The public site's row: its token reads both sites, and its property names the website team.
  const [site] = await db.select().from(websiteSite).where(eq(websiteSite.netlifySiteId, "3b1e97e6-e184-4251-badd-deed532be3ab")).limit(1);
  if (!site || site.archivedAt) return;
  try {
    const result = await stagingWatchTick(defaultDeps(db, site));
    if (result === "created") logger.info({ siteId: site.id }, "website staging watch handed main to the website team");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "website staging watch could not check");
  }
}
