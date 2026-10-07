import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";

/**
 * Connector setup calls providers with a credential the user just supplied.
 * When the provider refuses a step, the user needs to know which step failed,
 * what the provider said and what to do next. A provider refusal is a client
 * problem (wrong key, missing permission, plan limit), never a server crash.
 */

const MAX_PROVIDER_TEXT = 240;

/**
 * Make provider-authored error text safe to show and log: strip control
 * characters, remove any credential the caller knows about and anything that
 * looks like a token, and cap the length. Returns undefined for empty input.
 */
export function sanitizeProviderText(
  value: unknown,
  secrets: readonly (string | undefined)[] = [],
): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  text = redactSensitiveText(text)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:am|sk|pk|rk|xox[abpre]|xapp|ghp|gho|ghs|ghu|github_pat|nfp)[-_][A-Za-z0-9_-]{6,}/gi,
      "[redacted]",
    )
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > MAX_PROVIDER_TEXT
    ? `${text.slice(0, MAX_PROVIDER_TEXT - 3)}...`
    : text;
}

/** Map a provider HTTP status to the status GS Agentic Manager returns. */
export function providerFailureHttpStatus(providerStatus: number): number {
  // A provider 401 is about the pasted credential, not the GSAM session, so it
  // must not look like our own sign-in expiring.
  if (providerStatus === 401) return 400;
  if ([402, 403, 404, 409, 422, 429].includes(providerStatus)) return providerStatus;
  if (providerStatus >= 400 && providerStatus < 500) return 400;
  return 502;
}

function defaultHint(provider: string, status: number): string {
  switch (status) {
    case 401:
      return `Check that you pasted the complete ${provider} credential and that it has not been revoked or expired.`;
    case 402:
      return `Your ${provider} plan does not allow this; upgrade the plan or use another account.`;
    case 403:
      return `The credential does not have permission for this step; check its scopes or permissions in ${provider}.`;
    case 404:
      return `${provider} could not find that resource for this credential; check the identifier and that the credential covers it.`;
    case 409:
      return "The resource already exists or is in use; choose a different one.";
    case 422:
      return `${provider} could not accept the request details; correct them and try again.`;
    case 429:
      return `${provider} is limiting requests; wait a minute and try again.`;
    default:
      return status >= 500
        ? `${provider} had a problem; try again shortly.`
        : `Check the ${provider} settings and try again.`;
  }
}

export interface ProviderStepFailure {
  /** Display name, for example "AgentMail" or "Slack". */
  provider: string;
  /** What GSAM was doing, phrased to follow "refused to", e.g. "create an inbox". */
  step: string;
  /** Provider HTTP status. */
  status: number;
  /** Provider machine code, already sanitised. */
  providerCode?: string;
  /** Provider message, already sanitised. */
  providerMessage?: string;
  /** Specific next action. Falls back to a generic hint for the status. */
  hint?: string;
  /** Method and path template for the log line only, e.g. "POST /inboxes/{id}/api-keys". */
  request?: string;
}

/** Build the 4xx (or 502 for provider outages) error for a refused setup step. */
export function providerStepError(failure: ProviderStepFailure): HttpError {
  const { provider, step, status, providerCode, providerMessage } = failure;
  const said = [providerCode, providerMessage]
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join(": ");
  const verb = status >= 500 ? "could not" : "refused to";
  const hint = failure.hint ?? defaultHint(provider, status);
  const message = `${provider} ${verb} ${step} (${status}${said ? `: ${said}` : ""}). ${hint}`;
  logger.warn(
    { provider, step, providerStatus: status, providerCode, request: failure.request },
    "connector setup step failed at provider",
  );
  return new HttpError(providerFailureHttpStatus(status), message, {
    code: "provider_setup_refused",
    provider,
    step,
    providerStatus: status,
    ...(providerCode ? { providerCode } : {}),
  });
}

/** True for fetch transport failures: DNS, refused connection, timeout, abort. */
export function isProviderTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    (error instanceof TypeError && /fetch failed|network|socket/i.test(error.message))
  );
}

/** The provider could not be reached or answered with something unreadable. */
export function providerUnavailableError(
  provider: string,
  step: string,
  error: unknown,
): HttpError {
  const reason =
    error instanceof Error && error.name === "TimeoutError"
      ? "the request timed out"
      : error instanceof SyntaxError
        ? "the response could not be read"
        : "the provider could not be reached";
  logger.warn({ provider, step, reason }, "connector setup step could not reach provider");
  return new HttpError(
    502,
    `Could not ${step} with ${provider}: ${reason}. Check the network connection and try again.`,
    { code: "provider_unavailable", provider, step },
  );
}

/**
 * Run one provider call during setup. HttpErrors pass through unchanged;
 * transport failures and unreadable responses become a step-named 502.
 * Provider-specific API errors are mapped by `mapProviderError` when given.
 */
export async function providerStep<T>(
  provider: string,
  step: string,
  run: () => Promise<T>,
  mapProviderError?: (error: unknown) => HttpError | undefined,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const mapped = mapProviderError?.(error);
    if (mapped) throw mapped;
    if (isProviderTransportError(error) || error instanceof SyntaxError)
      throw providerUnavailableError(provider, step, error);
    throw error;
  }
}

/**
 * Fetch a provider JSON endpoint during setup. Transport failures, an
 * unreadable success body, rate limiting and provider outages become
 * step-named errors; other refusals are returned so the caller can keep its
 * provider-specific message (for example Slack's `ok: false` errors).
 */
export async function providerSetupJson<T extends object>(
  provider: string,
  step: string,
  request: () => Promise<Response>,
): Promise<{ response: Response; body: Partial<T> }> {
  return providerStep(provider, step, async () => {
    const response = await request();
    let body: Partial<T>;
    try {
      body = await readProviderJson<Partial<T>>(response);
    } catch (error) {
      if (response.ok) throw providerUnavailableError(provider, step, error);
      body = {};
    }
    if (response.status === 429 || response.status >= 500)
      throw providerStepError({ provider, step, status: response.status });
    return { response, body };
  });
}

/** Read a provider JSON body; an unreadable body becomes a SyntaxError. */
export async function readProviderJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new SyntaxError(`Provider returned a non-JSON response (${response.status})`);
  }
}
