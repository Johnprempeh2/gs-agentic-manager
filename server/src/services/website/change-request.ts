import { and, asc, eq, isNull, like, notInArray, or } from "drizzle-orm";
import { issues as issuesTable, type Db } from "@greatstone/db";
import {
  inspectWebsitePuckData,
  type CreateWebsiteChangeRequest,
  type WebsiteChangeRequestResult,
  type WebsitePageComment,
} from "@greatstone/shared";
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
//
// Ask an agent (GRE-2350) is the same task from the full-screen editor: a
// selected block, or with nothing selected the whole page, plus the width the
// person saw. The page's open tasks are its comments; the editor lists them.

export const WEBSITE_CHANGE_REQUEST_ORIGIN_KIND = "website_change_request";

/** One line of untrusted text, safe inside a Markdown code span. */
function inline(value: string, max = 200) {
  return value.replace(/[`\r\n]+/g, " ").trim().slice(0, max);
}

const WIDTH_LABELS = { laptop: "Laptop (1440 px)", tablet: "Tablet (768 px)", phone: "Phone (390 px)" } as const;

/**
 * The task's description ends with this hidden line, so the editor can list
 * the comment without parsing the prose. `<` and `>` are JSON-escaped, so the
 * person's words cannot close the HTML comment.
 */
const MARKER_PREFIX = "<!-- gsam-website-comment ";
const MARKER_RE = /<!-- gsam-website-comment (\{.*?\}) -->/;

interface CommentMarker {
  request: string;
  blockId: string | null;
  blockType: string | null;
  blockLabel: string | null;
  pageRevisionId: string;
  width: string | null;
}

function markerLine(marker: CommentMarker) {
  return `${MARKER_PREFIX}${JSON.stringify(marker).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

/** The marker in a task's description, or null when it is missing or edited out of shape. */
export function readWebsiteCommentMarker(description: string | null): CommentMarker | null {
  const match = description ? MARKER_RE.exec(description) : null;
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as Partial<CommentMarker>;
    if (typeof value.request !== "string") return null;
    const text = (field: unknown) => (typeof field === "string" ? field : null);
    return {
      request: value.request,
      blockId: text(value.blockId),
      blockType: text(value.blockType),
      blockLabel: text(value.blockLabel),
      pageRevisionId: text(value.pageRevisionId) ?? "",
      width: text(value.width),
    };
  } catch {
    return null;
  }
}

/** A page's address on the site: the domain and the page's path. */
function pageUrl(domain: string, slug: string) {
  return `https://${domain}${slug.startsWith("/") ? slug : `/${slug}`}`;
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
      const blockId = request.blockId ?? null;
      const blockType = request.blockType ?? null;
      if (blockId && blockType) {
        const inspected = inspectWebsitePuckData(content);
        const block = inspected.ok ? inspected.blocks.get(blockId) : undefined;
        if (!block || block.type !== blockType) {
          throw unprocessable("That block is not on this version of the page. Reload the page and pick it again.", {
            code: "website_change_block_unknown",
          });
        }
      }

      const team = await websiteTeamAgent(db, site.companyId, site.propertyId);
      const label = blockType ? inline(request.blockLabel || blockType, 80) : "the whole page";
      const source = request.source ?? null;
      const width = request.width ?? null;
      let created = true;
      const reference = blockId && blockType
        ? [
            "**Block (durable reference)**",
            "",
            `- Site: ${inline(site.name)} (\`${site.domain}\`, id \`${site.id}\`)`,
            `- Page: ${inline(page.title)} (\`${inline(page.slug)}\`, id \`${page.id}\`)`,
            `- Page address: ${pageUrl(site.domain, page.slug)}`,
            `- Page revision: \`${request.pageRevisionId}\``,
            `- Block id: \`${blockId}\``,
            `- Block type: \`${blockType}\`${request.blockLabel ? ` (shown as \`${label}\`)` : ""}`,
            ...(width ? [`- Seen at: ${WIDTH_LABELS[width]}`] : []),
            ...(request.engine ? [`- Engine: \`${inline(request.engine.version, 100)}\` at commit \`${request.engine.commit}\``] : []),
            "",
            source
              ? `Hint only, may be out of date: the frame says the block is drawn in \`${source.file}\` line ${source.line}. Find the block by its id and type, not by this line.`
              : "No source hint was sent. Find the block by its id and type.",
          ]
        : [
            "**Page (durable reference)**",
            "",
            `- Site: ${inline(site.name)} (\`${site.domain}\`, id \`${site.id}\`)`,
            `- Page: ${inline(page.title)} (\`${inline(page.slug)}\`, id \`${page.id}\`)`,
            `- Page address: ${pageUrl(site.domain, page.slug)}`,
            `- Page revision: \`${request.pageRevisionId}\``,
            ...(width ? [`- Seen at: ${WIDTH_LABELS[width]}`] : []),
            "",
            "No block was selected: the comment is about the whole page.",
          ];
      const issue = await issues.create(site.companyId, {
        title: `Website change: ${label} on ${inline(page.title, 80)}`,
        description: [
          blockId
            ? "A person picked this block on the page and asked for a change."
            : "A person asked for a change to this page from the website editor.",
          "",
          "**The change, in their words**",
          "",
          ...request.request.split(/\r?\n/).map((line) => `> ${line}`),
          "",
          ...reference,
          "",
          "No screenshot was sent: the site's editor cannot capture one yet.",
          "",
          "Make the change on the page's draft (or in the engine), then say on this task what changed. The person sees your draft in the editor. Do not publish: publishing stays a request a person approves.",
          "",
          markerLine({
            request: request.request,
            blockId,
            blockType,
            blockLabel: request.blockLabel || null,
            pageRevisionId: request.pageRevisionId,
            width,
          }),
        ].join("\n"),
        status: "todo",
        priority: "medium",
        assigneeAgentId: team.id,
        projectId: team.projectId,
        originKind: WEBSITE_CHANGE_REQUEST_ORIGIN_KIND,
        originId: blockId ? `${page.id}:${blockId}` : page.id,
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

    /** The page's open comments, oldest first and numbered: change request tasks not done or cancelled. */
    async listOpen(page: PageRow): Promise<WebsitePageComment[]> {
      const rows = await db
        .select()
        .from(issuesTable)
        .where(
          and(
            eq(issuesTable.companyId, page.companyId),
            eq(issuesTable.originKind, WEBSITE_CHANGE_REQUEST_ORIGIN_KIND),
            or(eq(issuesTable.originId, page.id), like(issuesTable.originId, `${page.id}:%`)),
            notInArray(issuesTable.status, ["done", "cancelled"]),
            isNull(issuesTable.hiddenAt),
          ),
        )
        .orderBy(asc(issuesTable.createdAt), asc(issuesTable.id));
      return rows.map((row, index) => {
        const marker = readWebsiteCommentMarker(row.description);
        // Older click-to-change tasks have no marker; their origin still names the block.
        const originBlock = row.originId?.startsWith(`${page.id}:`) ? row.originId.slice(page.id.length + 1) : null;
        return {
          number: index + 1,
          issueId: row.id,
          identifier: row.identifier ?? null,
          title: row.title,
          status: row.status,
          request: marker?.request ?? row.title,
          blockId: marker ? marker.blockId : originBlock,
          blockType: marker?.blockType ?? null,
          blockLabel: marker?.blockLabel ?? null,
          pageRevisionId: marker?.pageRevisionId || null,
          width: marker?.width ?? null,
          assigneeAgentId: row.assigneeAgentId ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    },
  };
}
