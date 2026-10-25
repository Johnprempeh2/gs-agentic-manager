import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, companies, issues, projects, websiteProperties, websiteRelease, websiteSite } from "@greatstone/db";
import type { WebsitePendingReason } from "@greatstone/shared";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { findChiefAgent } from "../memory-gateway/steward-grant-renewal.js";
import { pendingLongAlertText } from "./messages.js";

// The 30-minute Pending alert (GRE-2132; ADR GRE-1914 section 4.1 step 8;
// copy GRE-2107 `alert.pending_long`). A release still Pending 30 minutes
// after its switch raises one task for the website team; the Releases panel
// already offers the person a rollback. This sweep only reads releases and
// makes that task: it never retries, rebuilds, restores, publishes or calls
// Netlify. A release is Pending once (Retry keeps it Pending, then it ends
// Live or superseded), so the release id is the spell: one alert per release.

export const WEBSITE_PENDING_LONG_ORIGIN_KIND = "website_pending_long";
export const WEBSITE_PENDING_ALERT_AFTER_MS = 30 * 60_000;

const REASON_TEXT: Record<WebsitePendingReason, string> = {
  build_failed: "the site did not rebuild",
  build_timeout: "the rebuild took too long",
  build_not_started: "the rebuild did not start",
  verify_failed: "the live pages do not show this release yet",
  server_restarted: "GSAM restarted during this Publish",
};

/** The website team: the lead agent of the site's project, else the company's lead agent. */
export async function websiteTeamAgent(db: Db, companyId: string, propertyId: string | null) {
  const [project] = propertyId
    ? await db
        .select({ projectId: projects.id, leadAgentId: agents.id })
        .from(websiteProperties)
        .innerJoin(projects, and(eq(projects.id, websiteProperties.projectId), eq(projects.companyId, companyId)))
        .leftJoin(agents, and(eq(agents.id, projects.leadAgentId), eq(agents.companyId, companyId), ne(agents.status, "terminated")))
        .where(and(eq(websiteProperties.companyId, companyId), eq(websiteProperties.id, propertyId)))
        .limit(1)
    : [];
  const agentId = project?.leadAgentId ?? (await findChiefAgent(db, companyId))?.id ?? null;
  return { id: agentId, projectId: project?.projectId ?? null };
}

/**
 * Raises `alert.pending_long` for every release Pending 30 minutes or more
 * with no alert yet. Safe to run often and twice at once in one process (the
 * caller keeps it single-flight); a crash after the task is made is not
 * repeated, because the task itself is the record.
 */
export async function raiseWebsitePendingAlerts(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - WEBSITE_PENDING_ALERT_AFTER_MS);
  const due = await db
    .select({
      release: websiteRelease,
      siteName: websiteSite.name,
      siteDomain: websiteSite.domain,
      propertyId: websiteSite.propertyId,
      issuePrefix: companies.issuePrefix,
    })
    .from(websiteRelease)
    .innerJoin(websiteSite, and(eq(websiteSite.companyId, websiteRelease.companyId), eq(websiteSite.id, websiteRelease.siteId)))
    .innerJoin(companies, eq(companies.id, websiteRelease.companyId))
    .where(
      and(
        eq(websiteRelease.status, "pending"),
        // "Pending since" in the Releases panel is the switch time.
        sql`coalesce(${websiteRelease.switchedAt}, ${websiteRelease.updatedAt}) <= ${cutoff.toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from ${issues}
          where ${issues.companyId} = ${websiteRelease.companyId}
            and ${issues.originKind} = ${WEBSITE_PENDING_LONG_ORIGIN_KIND}
            and ${issues.originId} = ${websiteRelease.id}::text
        )`,
      ),
    )
    .orderBy(asc(websiteRelease.switchedAt));

  let raised = 0;
  for (const { release, siteName, siteDomain, propertyId, issuePrefix } of due) {
    try {
      const reason = REASON_TEXT[release.pendingReason as WebsitePendingReason] ?? "the live check has not passed";
      const text = pendingLongAlertText({ number: release.number, site: siteName, reason });
      const team = await websiteTeamAgent(db, release.companyId, propertyId);
      const since = (release.switchedAt ?? release.updatedAt).toISOString();
      await issueService(db).create(release.companyId, {
        title: text.title,
        description: [
          `${text.body}`,
          "",
          `- Site: ${siteName} (${siteDomain})`,
          `- Release ${release.number} (id \`${release.id}\`), Pending since ${since}`,
          `- Started by user \`${release.publishedByUserId ?? "unknown"}\``,
          "",
          `Only a person can Retry or roll back, from the site's Releases panel ([Website](${issuePrefix ? `/${issuePrefix}` : ""}/website)). GSAM does not retry or roll back by itself.`,
          "Find out why the rebuild or the live check fails (the release's Details show the build log), and tell the person what to do: Retry, or roll back to the release visitors saw before.",
          "",
          "This alert is raised once for this release. Close it when the release is Live or rolled back.",
        ].join("\n"),
        status: "todo",
        priority: "high",
        assigneeAgentId: team.id,
        projectId: team.projectId,
        originKind: WEBSITE_PENDING_LONG_ORIGIN_KIND,
        originId: release.id,
      });
      if (!team.id) logger.warn({ companyId: release.companyId, releaseId: release.id }, "website pending alert has no lead agent to go to");
      raised += 1;
    } catch (err) {
      // The next sweep tries this release again; others go on.
      logger.error({ err, releaseId: release.id }, "website pending alert could not be raised");
    }
  }
  return { raised };
}
