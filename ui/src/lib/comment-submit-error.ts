import { ApiError } from "../api/client";

const FALLBACK = "Could not post your comment";
const SHOWN_ISSUES = 2;

type ValidationIssue = { path?: unknown; message?: unknown };

function describeIssue(issue: ValidationIssue): string | null {
  const message = typeof issue.message === "string" ? issue.message.trim() : "";
  if (!message) return null;
  const path = Array.isArray(issue.path)
    ? issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
    : "";
  return path ? `${path}: ${message}` : message;
}

/**
 * Toast text for a refused comment. A bare "Validation error" hides which
 * field failed, and the field can belong to stored data rather than the
 * comment itself (GRE-1688), so name each failing field.
 */
export function commentSubmitErrorText(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK;
  const headline = error.message || FALLBACK;
  if (!(error instanceof ApiError)) return headline;
  const details = (error.body as { details?: unknown } | null)?.details;
  if (!Array.isArray(details)) return headline;
  const described = details
    .map((issue) => (issue && typeof issue === "object" ? describeIssue(issue as ValidationIssue) : null))
    .filter((text): text is string => text !== null);
  if (!described.length) return headline;
  const shown = described.slice(0, SHOWN_ISSUES).join("; ");
  const more = described.length > SHOWN_ISSUES ? ` (+${described.length - SHOWN_ISSUES} more)` : "";
  return `${headline}: ${shown}${more}`;
}
