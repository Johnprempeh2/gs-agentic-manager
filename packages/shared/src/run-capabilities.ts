/**
 * Tools an agent can say it needs on the machine that runs it.
 *
 * An agent lists them in `adapterConfig.requiredCapabilities`. When the list
 * is not empty, the server checks each tool at the start of a local run and
 * stops the run early, with a plain reason, if one is missing. When the list
 * is empty or absent, nothing is checked and runs behave as before.
 */
export const RUN_CAPABILITY_KEYS = ["git", "github_cli", "docker", "chromium"] as const;

export type RunCapabilityKey = (typeof RUN_CAPABILITY_KEYS)[number];

export const RUN_CAPABILITY_LABELS: Record<RunCapabilityKey, string> = {
  git: "Git",
  github_cli: "GitHub command line tool (gh), signed in",
  docker: "Docker, running",
  chromium: "Chromium browser for Playwright",
};

export const REQUIRED_CAPABILITIES_CONFIG_KEY = "requiredCapabilities";

export function isRunCapabilityKey(value: unknown): value is RunCapabilityKey {
  return typeof value === "string" && (RUN_CAPABILITY_KEYS as readonly string[]).includes(value);
}

/**
 * Reads the declared tools from an adapter config. Unknown entries and
 * duplicates are dropped, so a stray value never blocks a run.
 */
export function readRequiredRunCapabilities(config: unknown): RunCapabilityKey[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const raw = (config as Record<string, unknown>)[REQUIRED_CAPABILITIES_CONFIG_KEY];
  if (!Array.isArray(raw)) return [];
  const result: RunCapabilityKey[] = [];
  for (const entry of raw) {
    const key = typeof entry === "string" ? entry.trim() : entry;
    if (isRunCapabilityKey(key) && !result.includes(key)) result.push(key);
  }
  return result;
}
