import { redactSensitiveText } from "../redaction.js";
import { MANAGED_AI_HOME_PREFIX } from "./managed-ai-home-sweep.js";

/**
 * The end-of-run work for a managed AI connection: `refresh` writes a provider's
 * refreshed sign-in back to the vault (file-based subscriptions only), and
 * `cleanup` removes the per-run AI home.
 */
export type ManagedAiCleanupStep = "refresh" | "cleanup";

export class ManagedAiCleanupError extends Error {
  constructor(
    readonly provider: string,
    readonly method: string,
    readonly failures: ReadonlyArray<{ step: ManagedAiCleanupStep; error: unknown }>,
  ) {
    super(`AI connection ${failures.map((failure) => failure.step).join(" and ")} failed`);
    this.name = "ManagedAiCleanupError";
  }
}

/** Run every step, even after an earlier one fails, and report each failure with its step. */
export async function runManagedAiCleanup(input: {
  provider: string;
  method: string;
  refresh?: () => Promise<void>;
  remove: () => Promise<void>;
}) {
  const failures: Array<{ step: ManagedAiCleanupStep; error: unknown }> = [];
  if (input.refresh) {
    try {
      await input.refresh();
    } catch (error) {
      failures.push({ step: "refresh", error });
    }
  }
  try {
    await input.remove();
  } catch (error) {
    failures.push({ step: "cleanup", error });
  }
  if (failures.length > 0) throw new ManagedAiCleanupError(input.provider, input.method, failures);
}

export type ManagedAiCleanupCause = {
  /** Allowlisted class names and codes, outermost first, e.g. `Error [ENOTEMPTY]`. */
  chain: string;
  code?: string;
  syscall?: string;
  /** Short and redacted. Omitted when the error can quote file content. */
  message?: string;
};

// Same allowlists as the cloud connector's transport diagnostics (PR #269):
// names and codes are kept only when they look like names and codes.
const ERROR_NAME = /^[A-Z][A-Za-z]{0,48}(?:Error|Exception)$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const ERROR_SYSCALL = /^[a-z][a-z0-9_]{0,31}$/;
const CAUSE_DEPTH = 5;
const MESSAGE_MAX_CHARS = 160;
// Parser messages quote the input they reject, and the input here can be an
// auth file. Keep only the class name for these.
const CONTENT_QUOTING_ERRORS = new Set(["SyntaxError"]);
const MANAGED_AI_HOME_PATH = new RegExp(`[^\\s'"]*${MANAGED_AI_HOME_PREFIX}[^\\s/'"]*`, "g");
// Long unbroken runs of token characters: keys, tokens, hashes and IDs.
const OPAQUE_RUN = /[A-Za-z0-9+_=.-]{32,}/g;

function sanitizeMessage(message: string) {
  const cleaned = redactSensitiveText(
    message
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // The per-run home's name carries company and grant IDs; the part after it is the useful bit.
      .replace(MANAGED_AI_HOME_PATH, "<ai-home>"),
  ).replace(OPAQUE_RUN, "[redacted]");
  return cleaned.length <= MESSAGE_MAX_CHARS ? cleaned : `${cleaned.slice(0, MESSAGE_MAX_CHARS - 3)}...`;
}

/** Describe a failure using allowlisted names and codes plus a short redacted message. */
export function describeManagedAiCleanupFailure(error: unknown): ManagedAiCleanupCause {
  const chain: string[] = [];
  let code: string | undefined;
  let syscall: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as { name?: unknown; code?: unknown; syscall?: unknown; cause?: unknown };
    const name = typeof candidate.name === "string" && ERROR_NAME.test(candidate.name) ? candidate.name : "Error";
    const candidateCode = typeof candidate.code === "string" && ERROR_CODE.test(candidate.code)
      ? candidate.code : undefined;
    code ??= candidateCode;
    if (!syscall && typeof candidate.syscall === "string" && ERROR_SYSCALL.test(candidate.syscall)) {
      syscall = candidate.syscall;
    }
    chain.push(candidateCode ? `${name} [${candidateCode}]` : name);
    current = candidate.cause;
  }
  const outer = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : null;
  const quotesContent = typeof outer?.name === "string" && CONTENT_QUOTING_ERRORS.has(outer.name);
  const message = !quotesContent && typeof outer?.message === "string" && outer.message.trim()
    ? sanitizeMessage(outer.message)
    : undefined;
  return {
    chain: chain.length > 0 ? chain.join(" > ") : "non-error rejection",
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
    ...(message ? { message } : {}),
  };
}

/** Log fields for "AI connection refresh or cleanup failed": provider, step and a safe cause. */
export function managedAiCleanupLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof ManagedAiCleanupError)) {
    return { step: "unknown", cause: describeManagedAiCleanupFailure(error) };
  }
  const [first, ...rest] = error.failures;
  return {
    provider: error.provider,
    method: error.method,
    step: error.failures.map((failure) => failure.step).join("+"),
    cause: describeManagedAiCleanupFailure(first?.error),
    ...(rest.length > 0
      ? { otherFailures: rest.map((failure) => ({ step: failure.step, cause: describeManagedAiCleanupFailure(failure.error) })) }
      : {}),
  };
}
