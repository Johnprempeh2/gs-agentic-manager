/**
 * Install limits for one client instance (GRE-141).
 *
 * `scripts/client-instance.sh` sets `GSAM_INSTALL_LIMITS` at every start, e.g.
 * `{"v":1,"agentBudgetMonthlyCents":N,"agentMaxDailyRuns":N,"maxConcurrentRuns":N}`.
 * The values are settings of that instance, never code and never stored in
 * the database:
 *
 * - every new agent without its own budget gets `agentBudgetMonthlyCents` as
 *   its monthly budget (hard stop on), and `agentMaxDailyRuns` as its daily
 *   run cap unless it names one;
 * - `maxConcurrentRuns` is the run cap of the whole install; it replaces the
 *   instance "run admission" cap.
 *
 * Absent env = no limits (self-hosted and internal installs). A malformed
 * value refuses startup: a silently dropped limit is worse than a loud failure.
 */

export const INSTALL_LIMITS_ENV_KEY = "GSAM_INSTALL_LIMITS";

export interface InstallLimits {
  agentBudgetMonthlyCents: number;
  agentMaxDailyRuns: number;
  maxConcurrentRuns: number;
}

const FIELDS = ["agentBudgetMonthlyCents", "agentMaxDailyRuns", "maxConcurrentRuns"] as const;

export function parseInstallLimits(raw: string | undefined): InstallLimits | null {
  if (raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${INSTALL_LIMITS_ENV_KEY} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${INSTALL_LIMITS_ENV_KEY} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`${INSTALL_LIMITS_ENV_KEY} must have "v": 1`);
  const unknown = Object.keys(record).filter((key) => key !== "v" && !(FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new Error(`${INSTALL_LIMITS_ENV_KEY} has unknown fields: ${unknown.join(", ")}`);
  }
  const limits = {} as InstallLimits;
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${INSTALL_LIMITS_ENV_KEY}.${field} must be a whole number of 1 or more`);
    }
    limits[field] = value;
  }
  return limits;
}

let cache: { raw: string | undefined; limits: InstallLimits | null } | null = null;

/** Parse-once accessor keyed on the raw value; index.ts calls it at boot so a bad value fails there. */
export function getInstallLimits(env: Record<string, string | undefined> = process.env): InstallLimits | null {
  const raw = env[INSTALL_LIMITS_ENV_KEY];
  if (cache && cache.raw === raw) return cache.limits;
  cache = { raw, limits: parseInstallLimits(raw) };
  return cache.limits;
}

const DAILY_RUN_CAP_KEYS = ["maxDailyRuns", "dailyRunLimit", "dailyRunCap", "maxRunsPerDay"] as const;

/**
 * The agent values a new agent is created with under these limits: the
 * default monthly budget when it has none, and the default daily run cap when
 * its heartbeat policy names none.
 */
export function applyInstallLimitsToNewAgent<T extends { budgetMonthlyCents?: number | null; runtimeConfig?: unknown }>(
  data: T,
  limits: InstallLimits | null,
): T {
  if (!limits) return data;
  const runtimeConfig =
    data.runtimeConfig && typeof data.runtimeConfig === "object" && !Array.isArray(data.runtimeConfig)
      ? { ...(data.runtimeConfig as Record<string, unknown>) }
      : {};
  const heartbeat =
    runtimeConfig.heartbeat && typeof runtimeConfig.heartbeat === "object" && !Array.isArray(runtimeConfig.heartbeat)
      ? { ...(runtimeConfig.heartbeat as Record<string, unknown>) }
      : {};
  if (DAILY_RUN_CAP_KEYS.every((key) => heartbeat[key] === undefined || heartbeat[key] === null)) {
    heartbeat.maxDailyRuns = limits.agentMaxDailyRuns;
  }
  runtimeConfig.heartbeat = heartbeat;
  const budget = data.budgetMonthlyCents ?? 0;
  return {
    ...data,
    budgetMonthlyCents: budget > 0 ? budget : limits.agentBudgetMonthlyCents,
    runtimeConfig,
  };
}
