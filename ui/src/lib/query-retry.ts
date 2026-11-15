import { ApiError } from "../api/client";

/** Answers that will not change by asking again a second later. */
const FINAL_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

/**
 * The app's query retry: up to three tries for a dropped connection or a
 * server error, none for a final answer such as "not found". Retrying a 404
 * kept a missing task on a loading skeleton for about seven seconds before it
 * said so (15 Nov).
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && FINAL_STATUSES.has(error.status)) return false;
  return failureCount < 3;
}
