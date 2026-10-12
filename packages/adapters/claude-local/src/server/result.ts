import type { AdapterExecutionResult } from "@greatstone/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  parseJson,
  parseObject,
  type RunProcessResult,
} from "@greatstone/adapter-utils/server-utils";
import {
  claudeModelUsageTotals,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeMaxTurnsResult,
  isClaudeModelNotFoundError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

// What the result of one claude CLI attempt depends on besides its output.
// It is plain JSON so it can be saved at spawn time and used again by a
// server that adopted the child after a hot restart.
export interface ClaudeResultContext {
  timeoutSec: number;
  cwd: string;
  promptBundleKey: string;
  mcpServerIdentity: string;
  remoteExecutionIdentity: Record<string, unknown> | null;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  biller: string;
  model: string;
  billingType: AdapterExecutionResult["billingType"];
}

export const CLAUDE_RECOVERY_CONTEXT_KIND = "claude_local_result_v1";

export interface ClaudeRecoveryContext extends ClaudeResultContext {
  kind: typeof CLAUDE_RECOVERY_CONTEXT_KIND;
  fallbackSessionId: string | null;
  clearSessionOnMissingSession: boolean;
}

export interface ClaudeAttemptOutput {
  proc: RunProcessResult;
  parsedStream: ReturnType<typeof parseClaudeStreamJson>;
  parsed: Record<string, unknown> | null;
}

function parseFallbackErrorMessage(proc: RunProcessResult) {
  const stderrLine =
    proc.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  if ((proc.exitCode ?? 0) === 0) {
    return "Failed to parse claude JSON output";
  }

  return stderrLine
    ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
    : `Claude exited with code ${proc.exitCode ?? -1}`;
}

export function buildClaudeAdapterResult(
attempt: ClaudeAttemptOutput,
opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
resultContext: ClaudeResultContext,
): AdapterExecutionResult {
const {
  timeoutSec,
  cwd,
  promptBundleKey,
  mcpServerIdentity,
  remoteExecutionIdentity,
  workspaceId,
  workspaceRepoUrl,
  workspaceRepoRef,
  biller,
  model,
  billingType,
} = resultContext;
  const { proc, parsedStream, parsed } = attempt;
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });
  const errorMeta =
    loginMeta.loginUrl != null
      ? {
          loginUrl: loginMeta.loginUrl,
        }
      : undefined;

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      errorMeta,
      clearSession: Boolean(opts.clearSessionOnMissingSession),
    };
  }

  if (!parsed) {
    const fallbackErrorMessage = parseFallbackErrorMessage(proc);
    const providerQuota =
      !loginMeta.requiresLogin &&
      (proc.exitCode ?? 0) !== 0 &&
      isClaudeProviderQuotaError({
        parsed: null,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage: fallbackErrorMessage,
      });
    const transientUpstream =
      !loginMeta.requiresLogin &&
      !providerQuota &&
      (proc.exitCode ?? 0) !== 0 &&
      isClaudeTransientUpstreamError({
        parsed: null,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage: fallbackErrorMessage,
      });
    const transientRetryNotBefore = providerQuota || transientUpstream
      ? extractClaudeRetryNotBefore({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        })
      : null;
    const errorCode = proc.errorCode
      // Forward the transport-level error code from the run-disposition seam
      // first, even on the unparsed path. A lost duplex control channel
      // surfaces the typed `duplex_channel_lost` code before any provider
      // classification, so the CLI lane and the ACP lane report it alike.
      ? proc.errorCode
      : loginMeta.requiresLogin
      ? "claude_auth_required"
      : isClaudeModelNotFoundError({
        parsed: null,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage: fallbackErrorMessage,
      })
      ? "model_not_found"
      : providerQuota
      ? "provider_quota"
      : transientUpstream
      ? "claude_transient_upstream"
      : null;
    const errorFamily = providerQuota ? "provider_quota" : transientUpstream ? "transient_upstream" : null;
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: fallbackErrorMessage,
      errorCode,
      errorFamily,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      errorMeta,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...(errorFamily ? { errorFamily } : {}),
        ...(transientRetryNotBefore
          ? { retryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(transientRetryNotBefore
          ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(providerQuota && transientRetryNotBefore
          ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() }
          : {}),
        ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
      },
      clearSession: Boolean(opts.clearSessionOnMissingSession),
    };
  }

  const fallbackModelUsageTotals = parsedStream.usage ? null : claudeModelUsageTotals(parsed.modelUsage);
  const usage =
    parsedStream.usage ??
    fallbackModelUsageTotals ??
    (() => {
      const usageObj = parseObject(parsed.usage);
      return {
        inputTokens: asNumber(usageObj.input_tokens, 0),
        cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
        outputTokens: asNumber(usageObj.output_tokens, 0),
      };
    })();
  const usageBasis = parsedStream.usage
    ? parsedStream.usageBasis
    : fallbackModelUsageTotals
    ? ("per_run" as const)
    : null;

  const rawResolvedSessionId =
    parsedStream.sessionId ??
    (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
  const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
  const poisonedPreviousMessageId = isClaudePoisonedPreviousMessageIdError(parsed);
  // Fable 5 policy refusals exit cleanly (exitCode=0, is_error=false), so this
  // is intentionally independent of `failed` — otherwise a refusal looks like a
  // successful run to GS Agentic Manager and the heartbeat stalls silently. See RY-604.
  const claudeRefusal = isClaudeRefusalResult(parsed);
  const parsedIsError = asBoolean(parsed.is_error, false);
  const parsedSubtype = asString(parsed.subtype, "").trim().toLowerCase();
  const parsedSucceeded = parsedSubtype === "success" && !parsedIsError;
  const failed = !parsedSucceeded && ((proc.exitCode ?? 0) !== 0 || parsedIsError);
  // Validate-before-persist guard: never persist a sessionId whose transcript
  // is known-poisoned. The Claude CLI keeps an on-disk JSONL keyed by the
  // session id; if the last entry contains a non-`msg_`-prefixed
  // `previous_message_id`, every subsequent `--resume` hits a 400 from
  // /v1/messages and the issue is permanently unrecoverable until the
  // sessionId is dropped server-side. Drop here so resolveNextSessionState
  // calls clearTaskSessions on the next heartbeat. See RED-978 / RED-976.
  const shouldDropSessionForPoison = poisonedPreviousMessageId;
  const resolvedSessionId = shouldDropSessionForPoison ? null : rawResolvedSessionId;
  const resolvedSessionParams = resolvedSessionId
    ? ({
      sessionId: resolvedSessionId,
      cwd,
      promptBundleKey,
      mcpServerIdentity,
      ...(remoteExecutionIdentity
        ? {
            remoteExecution: remoteExecutionIdentity,
          }
        : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
    } as Record<string, unknown>)
    : null;
  const errorMessage = failed
    ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`
    : null;
  const providerQuota =
    failed &&
    !loginMeta.requiresLogin &&
    !clearSessionForMaxTurns &&
    !poisonedPreviousMessageId &&
    isClaudeProviderQuotaError({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
      errorMessage,
    });
  const transientUpstream =
    failed &&
    !loginMeta.requiresLogin &&
    !clearSessionForMaxTurns &&
    !poisonedPreviousMessageId &&
    !providerQuota &&
    isClaudeTransientUpstreamError({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
      errorMessage,
    });
  const transientRetryNotBefore = providerQuota || transientUpstream
    ? extractClaudeRetryNotBefore({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      })
    : null;
  const resolvedErrorCode = proc.errorCode
    // Forward the transport-level error code from the run-disposition seam
    // first. A lost duplex control channel surfaces the typed
    // `duplex_channel_lost` code before any provider classification.
    ? proc.errorCode
    : loginMeta.requiresLogin
    ? "claude_auth_required"
    : failed && isClaudeModelNotFoundError({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
      errorMessage,
    })
    ? "model_not_found"
    : failed && clearSessionForMaxTurns
    ? "max_turns_exhausted"
    : failed && poisonedPreviousMessageId
    ? "claude_poisoned_previous_message_id"
    : providerQuota
    ? "provider_quota"
    : transientUpstream
    ? "claude_transient_upstream"
    : claudeRefusal
    ? "claude_refusal"
    : null;
  const errorFamily = providerQuota
    ? "provider_quota"
    : transientUpstream
    ? "transient_upstream"
    : claudeRefusal
    ? "model_refusal"
    : null;
  const mergedResultJson: Record<string, unknown> = {
    ...parsed,
    ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
    ...(failed && poisonedPreviousMessageId ? { stopReason: "claude_poisoned_previous_message_id" } : {}),
    ...(claudeRefusal ? { stopReason: "refusal", errorFamily: "model_refusal" } : {}),
    ...(errorFamily ? { errorFamily } : {}),
    ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
    ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
    ...(providerQuota && transientRetryNotBefore ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
    ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
  };

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: resolvedErrorCode,
    errorFamily,
    retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
    errorMeta,
    usage,
    ...(usageBasis ? { usageBasis } : {}),
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: "anthropic",
    biller,
    model: parsedStream.model || asString(parsed.model, model),
    billingType,
    costUsd: parsedStream.costUsd,
    resultJson: mergedResultJson,
    summary: parsedStream.summary || asString(parsed.result, ""),
    clearSession:
      clearSessionForMaxTurns ||
      // Clear-on-error: a poisoned previous_message_id is a deterministic
      // state error. Force the server to drop persisted session state for
      // this issue so the next continuation starts from a clean slate.
      poisonedPreviousMessageId ||
      Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
  };
}

// Rebuild the adapter result from output captured to a file. Returns null
// when the output holds no terminal `result` event: the run's result is not
// known, so the caller must keep treating it as lost.
export function recoverClaudeResultFromOutput(input: {
  stdout: string;
  stderr: string;
  recoveryContext: Record<string, unknown> | null;
}): AdapterExecutionResult | null {
  const context = input.recoveryContext;
  if (!context || context.kind !== CLAUDE_RECOVERY_CONTEXT_KIND) return null;
  const parsedStream = parseClaudeStreamJson(input.stdout);
  if (!parsedStream.resultJson) return null;
  const recovery = context as unknown as ClaudeRecoveryContext;
  // The adopting server did not spawn the child, so it has no exit code.
  // Success or failure comes from the result event itself.
  const proc: RunProcessResult = {
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: input.stdout,
    stderr: input.stderr,
    pid: null,
    startedAt: null,
  };
  return buildClaudeAdapterResult(
    { proc, parsedStream, parsed: parsedStream.resultJson ?? parseJson(input.stdout) },
    {
      fallbackSessionId: recovery.fallbackSessionId ?? null,
      clearSessionOnMissingSession: recovery.clearSessionOnMissingSession === true,
    },
    recovery,
  );
}
