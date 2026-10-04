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
