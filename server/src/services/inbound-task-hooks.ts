// Inbound task webhooks. A person makes one in Settings > Integrations and
// gets a URL and a token, shown once. An outside tool posts JSON there to
// create a task, with files attached. Tasks stay unassigned unless the person
// chose an agent for the hook, so nothing runs (or spends) on its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, inboundTaskHooks, issues } from "@greatstone/db";
import {
  INBOUND_TASK_MAX_TOTAL_BYTES,
  type CreateInboundTaskHook,
  type InboundTask,
  type InboundTaskHookSummary,
  type InboundTaskHookWithToken,
  type InboundTaskResult,
  type UpdateInboundTaskHook,
} from "@greatstone/shared";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES, normalizeUploadAttachmentContentType } from "../attachment-types.js";
import { forbidden, notFound, payloadTooLarge, unauthorized, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";

export const INBOUND_TASK_PATH_PREFIX = "/api/inbound/tasks/";
const ORIGIN_KIND = "inbound_webhook";

type HookRow = typeof inboundTaskHooks.$inferSelect;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function summary(row: HookRow): InboundTaskHookSummary {
  return {
    id: row.id,
    name: row.name,
    path: `${INBOUND_TASK_PATH_PREFIX}${row.publicId}`,
    assigneeAgentId: row.assigneeAgentId,
    enabled: !row.disabledAt,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    useCount: row.useCount,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The bearer token from `Authorization: Bearer <token>`, or the `X-GSAM-Token` header. */
export function tokenFromHeaders(authorization: string | undefined, tokenHeader: string | undefined) {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || tokenHeader?.trim() || null;
}

function decodeBase64(data: string) {
  const payload = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) return null;
  return Buffer.from(payload, "base64");
}

export interface InboundTaskHookDeps {
  storage?: StorageService;
  heartbeat?: IssueAssignmentWakeupDeps;
  now?: () => Date;
}

export function inboundTaskHookService(db: Db, deps: InboundTaskHookDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const issuesSvc = issueService(db);

  async function getHook(companyId: string, hookId: string) {
    const row = await db
      .select()
      .from(inboundTaskHooks)
      .where(and(eq(inboundTaskHooks.id, hookId), eq(inboundTaskHooks.companyId, companyId), isNull(inboundTaskHooks.revokedAt)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Webhook not found");
    return row;
  }

  async function assertAgent(companyId: string, agentId: string | null | undefined) {
    if (!agentId) return;
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw unprocessable("That agent is not in this company", { code: "agent_not_found" });
  }

  async function noteError(row: HookRow, message: string) {
    await db
      .update(inboundTaskHooks)
      .set({ lastError: message.slice(0, 300), lastErrorAt: now() })
      .where(eq(inboundTaskHooks.id, row.id));
  }

  return {
    async list(companyId: string) {
      const rows = await db
        .select()
        .from(inboundTaskHooks)
        .where(and(eq(inboundTaskHooks.companyId, companyId), isNull(inboundTaskHooks.revokedAt)))
        .orderBy(inboundTaskHooks.createdAt);
      return rows.map(summary);
    },

    async create(companyId: string, input: CreateInboundTaskHook, userId: string | null): Promise<InboundTaskHookWithToken> {
      await assertAgent(companyId, input.assigneeAgentId);
      const token = `gsam_ith_${randomBytes(24).toString("base64url")}`;
      const [row] = await db
        .insert(inboundTaskHooks)
        .values({
          companyId,
          name: input.name,
          publicId: `ith_${randomBytes(12).toString("hex")}`,
          tokenHash: hashToken(token),
          assigneeAgentId: input.assigneeAgentId ?? null,
          createdByUserId: userId,
        })
        .returning();
      return { ...summary(row!), token };
    },

    async update(companyId: string, hookId: string, input: UpdateInboundTaskHook) {
      const row = await getHook(companyId, hookId);
      if (input.assigneeAgentId !== undefined) await assertAgent(companyId, input.assigneeAgentId);
      const [updated] = await db
        .update(inboundTaskHooks)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId } : {}),
          ...(input.enabled !== undefined ? { disabledAt: input.enabled ? null : row.disabledAt ?? now() } : {}),
          updatedAt: now(),
        })
        .where(eq(inboundTaskHooks.id, row.id))
        .returning();
      return summary(updated!);
    },

    /** A new token; the old one stops working at once. */
    async rotate(companyId: string, hookId: string): Promise<InboundTaskHookWithToken> {
      const row = await getHook(companyId, hookId);
      const token = `gsam_ith_${randomBytes(24).toString("base64url")}`;
      const [updated] = await db
        .update(inboundTaskHooks)
        .set({ tokenHash: hashToken(token), updatedAt: now() })
        .where(eq(inboundTaskHooks.id, row.id))
        .returning();
      return { ...summary(updated!), token };
    },

    async revoke(companyId: string, hookId: string) {
      const row = await getHook(companyId, hookId);
      await db.update(inboundTaskHooks).set({ revokedAt: now(), updatedAt: now() }).where(eq(inboundTaskHooks.id, row.id));
      return summary(row);
    },

    /**
     * Handles one post from an outside tool. Unknown, revoked and wrong-token
     * requests all get the same 401, so the URL does not reveal whether a hook
     * exists. A turned-off hook answers 403 once the token checks out.
     */
    async receive(publicId: string, token: string | null, body: InboundTask): Promise<{ hook: HookRow; result: InboundTaskResult }> {
      const row = await db
        .select()
        .from(inboundTaskHooks)
        .where(and(eq(inboundTaskHooks.publicId, publicId), isNull(inboundTaskHooks.revokedAt)))
        .then((rows) => rows[0] ?? null);
      const expected = Buffer.from(row?.tokenHash ?? "0".repeat(64), "hex");
      const given = Buffer.from(hashToken(token ?? ""), "hex");
      if (!row || !token || !timingSafeEqual(expected, given)) {
        throw unauthorized("Unknown webhook or wrong token");
      }
      if (row.disabledAt) {
        throw forbidden("This webhook is turned off. Turn it on in Settings > Integrations.", { code: "webhook_off" });
      }

      // Decode and check every file before creating anything.
      const files: Array<{ name: string; contentType: string; body: Buffer }> = [];
      let total = 0;
      for (const file of body.files ?? []) {
        const decoded = decodeBase64(file.data);
        if (!decoded || decoded.length === 0) {
          const message = `File "${file.name}" is not valid base64 or is empty.`;
          await noteError(row, message);
          throw unprocessable(message, { code: "file_invalid" });
        }
        const contentType = normalizeUploadAttachmentContentType({
          contentType: file.contentType ?? null,
          originalFilename: file.name,
          isAllowedContentType,
        });
        if (!isAllowedContentType(contentType)) {
          const message = `File "${file.name}" has a type this workspace does not accept (${contentType}).`;
          await noteError(row, message);
          throw unprocessable(message, { code: "file_type_not_allowed" });
        }
        total += decoded.length;
        if (decoded.length > MAX_ATTACHMENT_BYTES || total > INBOUND_TASK_MAX_TOTAL_BYTES) {
          const message = "The files are too large. Send at most 7 MB in one request.";
          await noteError(row, message);
          throw payloadTooLarge(message, { code: "files_too_large" });
        }
        files.push({ name: file.name, contentType, body: decoded });
      }
      if (files.length > 0 && !deps.storage) {
        throw unprocessable("File storage is not available on this server", { code: "storage_unavailable" });
      }

      const idempotencyKey = body.externalId ? `inbound:${row.id}:${body.externalId}` : null;
      if (body.externalId) {
        const existing = await db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(and(
            eq(issues.companyId, row.companyId),
            eq(issues.originKind, ORIGIN_KIND),
            eq(issues.originId, row.id),
            eq(issues.originFingerprint, body.externalId),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          return { hook: row, result: { taskId: existing.id, identifier: existing.identifier, attachments: 0, duplicate: true } };
        }
      }

      const issue = await issuesSvc.create(row.companyId, {
        title: body.title,
        description: body.description ?? null,
        status: "todo",
        priority: body.priority ?? "medium",
        dueDate: body.dueDate ?? null,
        assigneeAgentId: row.assigneeAgentId,
        responsibleUserId: row.createdByUserId,
        createdByUserId: row.createdByUserId,
        originKind: ORIGIN_KIND,
        originId: row.id,
        ...(body.externalId ? { originFingerprint: body.externalId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as Parameters<typeof issuesSvc.create>[1]);

      let attachments = 0;
      for (const file of files) {
        const stored = await deps.storage!.putFile({
          companyId: row.companyId,
          namespace: `issues/${issue.id}`,
          originalFilename: file.name,
          contentType: file.contentType,
          body: file.body,
        });
        await issuesSvc.createAttachment({
          issueId: issue.id,
          issueCommentId: null,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: null,
          createdByUserId: row.createdByUserId,
          createdByRunId: null,
        });
        attachments += 1;
      }

      await db
        .update(inboundTaskHooks)
        .set({ lastUsedAt: now(), useCount: sql`${inboundTaskHooks.useCount} + 1`, lastError: null, lastErrorAt: null })
        .where(eq(inboundTaskHooks.id, row.id));
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: `inbound-webhook:${row.id}`,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: { via: ORIGIN_KIND, hookId: row.id, hookName: row.name, attachments },
      });
      if (deps.heartbeat && row.assigneeAgentId) {
        void queueIssueAssignmentWakeup({
          heartbeat: deps.heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "inbound_webhook",
          requestedByActorType: "system",
        });
      }
      return { hook: row, result: { taskId: issue.id, identifier: issue.identifier ?? null, attachments, duplicate: false } };
    },
  };
}
