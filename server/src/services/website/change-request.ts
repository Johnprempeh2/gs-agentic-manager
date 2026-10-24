import type { Db } from "@greatstone/db";
import { inspectWebsitePuckData, type CreateWebsiteChangeRequest, type WebsiteChangeRequestResult } from "@greatstone/shared";
import { unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";
import { issueService } from "../issues.js";
import type { PageRow, SiteRow, WebsiteActor } from "./module.js";
import { websiteTeamAgent } from "./pending-alert.js";

// Click to change (GRE-2121; plan GRE-1831 section 3.4). A person picks a
// block in the preview, says what to change, and confirms; this makes one task
// for the website agent (the site project's lead). The task carries the
// durable reference (page, revision, block id and type, engine commit). The
// file and line the frame sent are only a hint: code moves, ids do not.

export const WEBSITE_CHANGE_REQUEST_ORIGIN_KIND = "website_change_request";

/** One line of untrusted text, safe inside a Markdown code span. */
function inline(value: string, max = 200) {
  return value.replace(/[`\r\n]+/g, " ").trim().slice(0, max);
}

export function websiteChangeRequestService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const issues = issueService(db);

  return {
    /**
     * Checks the block is in that revision of this page, then makes the task.
     * The same `requestId` returns the first task (`created: false`).
     */
    async create(input: {
      site: SiteRow;
      page: PageRow;
      revisionBody: string;
      request: CreateWebsiteChangeRequest;
      actor: WebsiteActor;
    }): Promise<{ result: WebsiteChangeRequestResult; created: boolean }> {
      const { site, page, revisionBody, request, actor } = input;
      let content: unknown = null;
      try {
        content = JSON.parse(revisionBody);
      } catch {
        content = null;
      }
      const inspected = inspectWebsitePuckData(content);
      const block = inspected.ok ? inspected.blocks.get(request.blockId) : undefined;
      if (!block || block.type !== request.blockType) {
        throw unprocessable("That block is not on this version of the page. Reload the preview and pick it again.", {
          code: "website_change_block_unknown",
        });
      }

      const team = await websiteTeamAgent(db, site.companyId, site.propertyId);
      const label = inline(request.blockLabel || request.blockType, 80);
      const source = request.source ?? null;
      let created = true;
      const issue = await issues.create(site.companyId, {
        title: `Website change: ${label} on ${inline(page.title, 80)}`,
        description: [
          "A person picked this block in the page preview and asked for a change (click to change).",
          "",
          "**The change, in their words**",
          "",
          ...request.request.split(/\r?\n/).map((line) => `> ${line}`),
          "",
          "**Block (durable reference)**",
          "",
          `- Site: ${inline(site.name)} (\`${site.domain}\`, id \`${site.id}\`)`,
          `- Page: ${inline(page.title)} (\`${inline(page.slug)}\`, id \`${page.id}\`)`,
          `- Page revision: \`${request.pageRevisionId}\``,
          `- Block id: \`${request.blockId}\``,
          `- Block type: \`${request.blockType}\`${request.blockLabel ? ` (shown as \`${label}\`)` : ""}`,
          `- Engine: \`${inline(request.engine.version, 100)}\` at commit \`${request.engine.commit}\``,
          "",
          source
            ? `Hint only, may be out of date: the frame says the block is drawn in \`${source.file}\` line ${source.line}. Find the block by its id and type, not by this line.`
            : "No source hint was sent. Find the block by its id and type.",
          "",
          "Make the change on the site's draft or in the engine, then say on this task what changed. Publishing stays with a person.",
        ].join("\n"),
        status: "todo",
        priority: "medium",
        assigneeAgentId: team.id,
        projectId: team.projectId,
        originKind: WEBSITE_CHANGE_REQUEST_ORIGIN_KIND,
        originId: `${page.id}:${request.blockId}`,
        createdByUserId: actor.userId,
        createdByAgentId: actor.agentId,
        idempotencyKey: `website-change:${page.id}:${request.requestId}`,
        onDeduplicated: () => {
          created = false;
        },
      });

      if (created) {
        if (!team.id) logger.warn({ companyId: site.companyId, siteId: site.id }, "website change request has no lead agent to go to");
        if (deps.heartbeat) {
          void queueIssueAssignmentWakeup({
            heartbeat: deps.heartbeat,
            issue,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "website_change_request",
            requestedByActorType: actor.agentId ? "agent" : "user",
            requestedByActorId: actor.agentId ?? actor.userId,
          });
        }
      }

      return {
        created,
        result: {
          issueId: issue.id,
          identifier: issue.identifier ?? null,
          title: issue.title,
          assigneeAgentId: issue.assigneeAgentId ?? null,
          projectId: issue.projectId ?? null,
        },
      };
    },
  };
}
