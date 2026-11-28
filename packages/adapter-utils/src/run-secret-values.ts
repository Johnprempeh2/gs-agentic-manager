// A run's own credentials (API key, git broker token, provider keys) reach
// the agent as env vars. When the agent prints its environment, the exact
// values land in tool output, which is saved in ACP session records and run
// logs (GRE-517). Key-name redaction cannot see them there, so these helpers
// redact by value: every secret value the run was given is replaced wherever
// it appears.

export const RUN_SECRET_VALUE_REDACTION = "***REDACTED***";

const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
// Short values ("1", "true", a port) would redact ordinary text.
const MIN_SECRET_VALUE_LENGTH = 12;

/**
 * Secret values from an env map: values of keys whose name looks secret, or
 * that are listed in `secretKeys`. Longest first, so a value that contains
 * another is replaced whole.
 */
export function collectRunSecretValues(
  env: Readonly<Record<string, unknown>> | null | undefined,
  options: { secretKeys?: Iterable<string>; extraValues?: Iterable<string | null | undefined> } = {},
): string[] {
  const listed = new Set(options.secretKeys ?? []);
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_VALUE_LENGTH) values.add(trimmed);
  };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (listed.has(key) || SENSITIVE_ENV_KEY.test(key)) add(value);
  }
  for (const value of options.extraValues ?? []) add(value);
  return [...values].sort((left, right) => right.length - left.length);
}

export function redactRunSecretValues(text: string, secretValues: readonly string[]): string {
  let result = text;
  for (const value of secretValues) {
    if (result.includes(value)) result = result.split(value).join(RUN_SECRET_VALUE_REDACTION);
  }
  return result;
}

// Values a run receives after it starts, such as a secret read through
// `POST /api/agents/me/secrets/:key/value`, are not in its launch env, so the
// lists above miss them (GRE-6519). The server adds each one here by run id;
// the run-log writer and the ACP session store read it on every write. Kept on
// globalThis so every copy of this module in the process shares one registry.
const LIVE_REGISTRY_KEY = Symbol.for("greatstone.runSecretValues.live");

function liveRegistry(): Map<string, Set<string>> {
  const holder = globalThis as { [LIVE_REGISTRY_KEY]?: Map<string, Set<string>> };
  holder[LIVE_REGISTRY_KEY] ??= new Map();
  return holder[LIVE_REGISTRY_KEY];
}

export function addLiveRunSecretValue(runId: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_VALUE_LENGTH) return;
  const registry = liveRegistry();
  const values = registry.get(runId) ?? new Set<string>();
  values.add(trimmed);
  registry.set(runId, values);
}

/** Call when the run has finished writing its log and session record. */
export function releaseLiveRunSecretValues(runId: string): void {
  liveRegistry().delete(runId);
}

/** `baseValues` plus the run's live values, longest first. */
export function withLiveRunSecretValues(runId: string | null | undefined, baseValues: readonly string[]): string[] {
  const live = runId ? liveRegistry().get(runId) : undefined;
  if (!live || live.size === 0) return [...baseValues];
  return [...new Set([...baseValues, ...live])].sort((left, right) => right.length - left.length);
}

/** Deep copy of `value` with every string passed through `redactRunSecretValues`. */
export function redactRunSecretValuesDeep<T>(value: T, secretValues: readonly string[]): T {
  if (secretValues.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactRunSecretValues(node, secretValues);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
