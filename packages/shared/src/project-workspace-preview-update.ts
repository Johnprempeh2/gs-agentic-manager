import { z } from "zod";
import type {
  ProjectWorkspacePreviewUpdateState,
  ProjectWorkspacePreviewUpdateStatus,
  ProjectWorkspacePreviewUpdateTrigger,
} from "./types/project.js";

/** Key under project workspace `metadata` that holds the live preview update state. */
export const PREVIEW_UPDATE_METADATA_KEY = "previewUpdate";

const STATUSES: readonly ProjectWorkspacePreviewUpdateStatus[] = ["updating", "updated", "up_to_date", "skipped", "failed"];
const TRIGGERS: readonly ProjectWorkspacePreviewUpdateTrigger[] = ["manual", "auto"];

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads the live preview update state from a project workspace's metadata.
 * Auto-update is on unless it was switched off.
 */
export function readProjectWorkspacePreviewUpdate(
  metadata: Record<string, unknown> | null | undefined,
): ProjectWorkspacePreviewUpdateState {
  const raw = metadata?.[PREVIEW_UPDATE_METADATA_KEY];
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const status = STATUSES.find((entry) => entry === record.status) ?? null;
  const trigger = TRIGGERS.find((entry) => entry === record.trigger) ?? null;
  return {
    autoUpdate: record.autoUpdate !== false,
    status,
    trigger,
    message: readString(record.message),
    commit: readString(record.commit),
    updatedAt: readString(record.updatedAt),
    checkedAt: readString(record.checkedAt),
  };
}

export const setProjectWorkspacePreviewAutoUpdateSchema = z.object({
  enabled: z.boolean(),
}).strict();

export type SetProjectWorkspacePreviewAutoUpdate = z.infer<typeof setProjectWorkspacePreviewAutoUpdateSchema>;
