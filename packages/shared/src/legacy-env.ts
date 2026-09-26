/**
 * Compatibility bridge between GS Agentic Manager's GSAM_* environment
 * variables and the PAPERCLIP_* names they replaced.
 *
 * The fork renamed every variable, but code we do not control still speaks the
 * old names: the upstream agent-runtime container images, the OpenClaw and
 * Hermes gateways, patched third-party packages, and agent skills installed
 * from outside this repo. Two directions keep them working:
 *
 *   inbound   adoptLegacyEnv()        an operator's existing PAPERCLIP_* config
 *                                     is read as GSAM_* (GSAM_* wins if both set)
 *   outbound  withLegacyEnvAliases()  every environment handed to an agent or
 *                                     gateway carries both names
 *
 * This file is excluded from scripts/greatstone-rebrand.mjs: the legacy names
 * below must survive every re-run of the rename.
 */

export const ENV_PREFIX = "GSAM_";
export const LEGACY_ENV_PREFIX = "PAPERCLIP_";

type EnvRecord = Record<string, string | undefined>;

/** `PAPERCLIP_API_URL` -> `GSAM_API_URL`; any other key comes back unchanged. */
export function fromLegacyEnvKey(key: string): string {
  return key.startsWith(LEGACY_ENV_PREFIX) ? ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length) : key;
}

/** `GSAM_API_URL` -> `PAPERCLIP_API_URL`; any other key comes back unchanged. */
export function toLegacyEnvKey(key: string): string {
  return key.startsWith(ENV_PREFIX) ? LEGACY_ENV_PREFIX + key.slice(ENV_PREFIX.length) : key;
}

/**
 * Inbound: copy each PAPERCLIP_* value onto its GSAM_* name when that name is
 * unset. Mutates `env` (defaults to process.env) and returns the adopted keys.
 */
export function adoptLegacyEnv(env: EnvRecord = process.env): string[] {
  const adopted: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const value = env[key];
    if (value === undefined) continue;
    const modern = fromLegacyEnvKey(key);
    if (env[modern] !== undefined) continue;
    env[modern] = value;
    adopted.push(modern);
  }
  return adopted;
}

/**
 * Outbound: a copy of `env` in which every GSAM_* key also appears under its
 * PAPERCLIP_* name. The GSAM_* value always wins, so a stale or forged legacy
 * value (say a PAPERCLIP_API_KEY smuggled in through config) can never shadow
 * the harness-minted one.
 */
export function withLegacyEnvAliases<T extends EnvRecord>(env: T): T & Record<string, T[keyof T]> {
  const out: EnvRecord = { ...env };
  for (const key of Object.keys(env)) {
    if (!key.startsWith(ENV_PREFIX)) continue;
    const value = env[key];
    if (value === undefined) continue;
    out[toLegacyEnvKey(key)] = value;
  }
  return out as T & Record<string, T[keyof T]>;
}
