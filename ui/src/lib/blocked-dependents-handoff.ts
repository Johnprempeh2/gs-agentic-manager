import { ApiError } from "../api/client";

/**
 * GRE-235: the server refuses to cancel a task that still blocks open tasks
 * (409 `issue_close_has_blocked_dependents`, GRE-225). Instead of showing that
 * error, the app asks the person where the blocked tasks go and re-sends the
 * same update with a `blockedDependents` choice.
 */
export const BLOCKED_DEPENDENTS_CONFLICT_CODE = "issue_close_has_blocked_dependents";

export interface BlockedDependent {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

export type BlockedDependentsDecision =
  | { action: "move"; issueId: string }
  | { action: "remove" };

export interface BlockedDependentsRequest {
  issueId: string;
  dependents: BlockedDependent[];
}

export type BlockedDependentsHandler = (
  request: BlockedDependentsRequest,
) => Promise<BlockedDependentsDecision | null>;

/** Thrown when the person closes the dialog: the task was not changed. */
export class BlockedDependentsHandoffCancelled extends Error {
  constructor() {
    super("Nothing changed: the task still blocks other tasks.");
    this.name = "BlockedDependentsHandoffCancelled";
  }
}

export function isBlockedDependentsHandoffCancelled(error: unknown): boolean {
  return error instanceof BlockedDependentsHandoffCancelled;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The dependents from a blocked-dependents 409, or null for any other error. */
export function readBlockedDependentsConflict(error: unknown): BlockedDependent[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = asRecord(error.body);
  const details = asRecord(body?.details);
  const code = body?.code ?? details?.code;
  if (code !== BLOCKED_DEPENDENTS_CONFLICT_CODE) return null;
  const raw = Array.isArray(details?.dependents) ? details.dependents : [];
  const dependents: BlockedDependent[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "string") continue;
    dependents.push({
      id: record.id,
      identifier: typeof record.identifier === "string" ? record.identifier : null,
      title: typeof record.title === "string" ? record.title : "",
      status: typeof record.status === "string" ? record.status : "",
    });
  }
  return dependents;
}

let activeHandler: BlockedDependentsHandler | null = null;

/** The dialog host registers here; returns an unregister function. */
export function registerBlockedDependentsHandler(handler: BlockedDependentsHandler) {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/**
 * Sends an issue update. On a blocked-dependents 409 it asks the registered
 * dialog and re-sends the same update with the choice. Without a dialog (or
 * for any other error) the original error is thrown unchanged.
 */
export async function sendWithBlockedDependentsHandoff<T>(
  issueId: string,
  data: Record<string, unknown>,
  send: (data: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  try {
    return await send(data);
  } catch (error) {
    const dependents = readBlockedDependentsConflict(error);
    const handler = activeHandler;
    if (!dependents || !handler) throw error;
    const decision = await handler({ issueId, dependents });
    if (!decision) throw new BlockedDependentsHandoffCancelled();
    return send({ ...data, blockedDependents: decision });
  }
}
