import { and, asc, eq, inArray, isNull, like, notInArray, or } from "drizzle-orm";
import { assets, issues as issuesTable, type Db } from "@greatstone/db";
import {
  inspectWebsitePuckData,
  type CreateWebsiteChangeRequest,
  type WebsiteChangeAttachment,
  type WebsiteChangeImageType,
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
//
// GRE-2518: the person can draw on the screenshot instead of, or as well as,
// writing. The editor attaches the marked-up PNG and the vector JSON; the task
// lists the markers and the labels so the agent can read them as text.
//
// GRE-2527: the person can also attach images (uploaded, or picked from
// Website media or Image Studio), reference sites and effects from the
// effects library, each with a one-line note. The task lists every one.

export const WEBSITE_CHANGE_REQUEST_ORIGIN_KIND = "website_change_request";

/** One line of untrusted text, safe inside a Markdown code span. */
function inline(value: string, max = 200) {
  return value.replace(/[`\r\n]+/g, " ").trim().slice(0, max);
}

const WIDTH_LABELS = { laptop: "Laptop (1440 px)", tablet: "Tablet (768 px)", phone: "Phone (390 px)" } as const;

/** What a comment with no words shows in the editor's Comments list. */
export const WEBSITE_DRAWING_ONLY_REQUEST = "Drawing on the page";
/** What a comment with only attachments (no words, no drawing) shows there. */
export const WEBSITE_ATTACHMENTS_ONLY_REQUEST = "Images and references";

/** The task's lines about the person's drawing, or none when they did not draw. */
function markupLines(markup: CreateWebsiteChangeRequest["markup"], blockId: string | null): string[] {
  if (!markup) return [];
  const marks = markup.marks === 1 ? "1 mark" : `${markup.marks} marks`;
  // The editor names the files after the block, or `page` (see websiteScreenshotFile in the UI).
  const stem = `website-${blockId ?? "page"}`;
  return [
    "**Their drawing**",
    "",
    `They drew ${marks} on the screenshot of ${blockId ? "the block" : "the page"}. Two more files are attached: the screenshot with the drawing on it (\`${stem}-markup.png\`) and the drawing as vector data in the screenshot's pixels (\`${stem}-markup.json\`).`,
    ...(markup.markers > 0
      ? [markup.markers === 1 ? "- Numbered marker: 1" : `- Numbered markers: 1 to ${markup.markers}, in the order placed`]
      : []),
    ...markup.labels.map((label) => `- Label: \`${inline(label, 120)}\``),
    "",
  ];
}

const ATTACHMENT_SOURCES = { website: "Website media", studio: "Image Studio" } as const;

/** The task's lines listing what the person attached, in the order they added it. */
function attachmentLines(attachments: WebsiteChangeAttachment[] | undefined): string[] {
  if (!attachments?.length) return [];
  const lines = attachments.map((attachment, index) => {
    const note = attachment.note ? ` Their note: \`${inline(attachment.note, 140)}\`` : "";
    const n = `${index + 1}.`;
    switch (attachment.kind) {
      case "upload":
        return `${n} Image they uploaded, attached to this task as \`${inline(attachment.name)}\`.${note}`;
      case "media":
        return `${n} Image from ${ATTACHMENT_SOURCES[attachment.source]}${attachment.label ? ` \`${inline(attachment.label)}\`` : ""}: asset \`${attachment.assetId}\`, at \`/api/assets/${attachment.assetId}/content\`.${note}`;
      case "link":
        return `${n} Reference site: \`${inline(attachment.url, 2000)}\`. Look at it for the idea; do not copy its words, images or code.${note}`;
      case "effect":
        return `${n} Effect from the effects library: \`${attachment.effectId}\`${attachment.label ? ` (${inline(attachment.label, 120)})` : ""}.${note}`;
    }
  });
  return ["**What they attached**", "", ...lines, ""];
}

/** The image type the bytes say, or null. Only PNG, JPEG, WebP and GIF: never SVG or anything a browser could run. */
export function sniffWebsiteChangeImage(bytes: Buffer): WebsiteChangeImageType | null {
  const starts = (signature: number[], at = 0) => bytes.length >= at + signature.length && signature.every((byte, index) => bytes[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** True when the task is a change request on this page (the whole page or one of its blocks). */
export function isWebsiteChangeRequestFor(
  issue: { companyId: string; originKind: string | null; originId: string | null },
  page: Pick<PageRow, "id" | "companyId">,
) {
  return (
    issue.companyId === page.companyId &&
    issue.originKind === WEBSITE_CHANGE_REQUEST_ORIGIN_KIND &&
    (issue.originId === page.id || Boolean(issue.originId?.startsWith(`${page.id}:`)))
  );
}

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
  /** GRE-2527: how many attachments, and whether there is a drawing. Older markers have neither. */
  attachments?: number;
  drawing?: boolean;
}

/** What the Comments list shows for a comment: the person's words, or what they sent instead. */
function commentText(marker: CommentMarker) {
  if (marker.request) return marker.request;
  return (marker.attachments ?? 0) > 0 && !marker.drawing ? WEBSITE_ATTACHMENTS_ONLY_REQUEST : WEBSITE_DRAWING_ONLY_REQUEST;
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
      ...(typeof value.attachments === "number" ? { attachments: value.attachments } : {}),
      ...(value.drawing === true ? { drawing: true } : {}),
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

      // A picked image must be an asset of this company: one client never points a task at another's file.
      const assetIds = [...new Set((request.attachments ?? []).flatMap((attachment) => (attachment.kind === "media" ? [attachment.assetId] : [])))];
      if (assetIds.length > 0) {
        const found = await db
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.companyId, site.companyId), inArray(assets.id, assetIds)));
        if (found.length !== assetIds.length) {
          throw unprocessable("One of the picked images is not in this company's media. Pick it again.", {
            code: "website_change_attachment_unknown",
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
          ...(request.request
            ? ["**The change, in their words**", "", ...request.request.split(/\r?\n/).map((line) => `> ${line}`), ""]
            : [request.markup ? "They wrote no words: the drawing says what to change." : "They wrote no words: what they attached says what to change.", ""]),
          ...markupLines(request.markup, blockId),
          ...attachmentLines(request.attachments),
          ...reference,
          "",
          request.screenshot
            ? `A screenshot of ${blockId ? "the block" : "the page"} as the person saw it is attached to this task.`
            : "No screenshot was sent: the site's editor did not capture one.",
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
            ...(request.attachments?.length ? { attachments: request.attachments.length } : {}),
            ...(request.markup ? { drawing: true } : {}),
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
          request: marker ? commentText(marker) : row.title,
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
