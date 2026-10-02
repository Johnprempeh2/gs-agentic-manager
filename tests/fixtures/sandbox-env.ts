import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../../packages/shared/src/legacy-env.ts";

// When an agent runs a Playwright harness, its shell carries the live instance's
// API URL, key, run and task ids. None of that may reach a sandbox server or the
// scripted agents it spawns. Playwright merges process.env into webServer.env, so
// leaving them out of `env` is not enough: remove them at the source.
//
// `keep` lists the prefixes of the harness's own knobs (for example
// "GSAM_ISSUE_PERF_"); every other GSAM_* variable, and every legacy-prefixed
// alias the compatibility bridge mirrors from it, is deleted.
export function scrubParentInstanceEnv(keep: readonly string[] = []): void {
  for (const key of Object.keys(process.env)) {
    const instanceKey = key.startsWith(ENV_PREFIX) || key.startsWith(LEGACY_ENV_PREFIX);
    if (instanceKey && !keep.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}
