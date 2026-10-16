import { z } from "zod";
import { ISSUE_PRIORITIES } from "../constants.js";

/** Files per inbound task, and the most decoded bytes all of them may carry together. */
export const INBOUND_TASK_MAX_FILES = 5;
export const INBOUND_TASK_MAX_TOTAL_BYTES = 7 * 1024 * 1024;

export const createInboundTaskHookSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Agent new tasks go to. Leave out to keep them unassigned, so no agent runs until a person assigns one. */
    assigneeAgentId: z.string().guid().nullable().optional(),
  })
  .strict();
export type CreateInboundTaskHook = z.infer<typeof createInboundTaskHookSchema>;

export const updateInboundTaskHookSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    assigneeAgentId: z.string().guid().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateInboundTaskHook = z.infer<typeof updateInboundTaskHookSchema>;

const inboundFileSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    contentType: z.string().trim().max(150).optional(),
    /** File contents as base64 (a `data:` URL prefix is accepted). */
    data: z.string().min(1),
  })
  .strict();

/** Body an outside tool posts to the inbound task URL. */
export const inboundTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
    /** The sender's own id for this item; a repeat with the same id returns the task made the first time. */
    externalId: z.string().trim().min(1).max(200).optional(),
    files: z.array(inboundFileSchema).max(INBOUND_TASK_MAX_FILES).optional(),
  });
export type InboundTask = z.infer<typeof inboundTaskSchema>;

export interface InboundTaskHookSummary {
  id: string;
  name: string;
  /** Path of the public URL, such as `/api/inbound/tasks/ith_...`. Join it to the instance address. */
  path: string;
  assigneeAgentId: string | null;
  enabled: boolean;
  lastUsedAt: string | null;
  useCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
}

/** Answer of create and rotate: the summary plus the token, shown this once. */
export interface InboundTaskHookWithToken extends InboundTaskHookSummary {
  token: string;
}

export interface InboundTaskResult {
  taskId: string;
  identifier: string | null;
  attachments: number;
  /** True when `externalId` matched a task this hook made before. */
  duplicate: boolean;
}
