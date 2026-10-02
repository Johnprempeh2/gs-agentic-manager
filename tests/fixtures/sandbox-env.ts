// When an agent runs a Playwright harness, its shell carries the live instance's
// API URL, key, run and task ids. None of that may reach a sandbox server or the
// scripted agents it spawns. Playwright merges process.env into webServer.env, so
// leaving them out of `env` is not enough: remove them at the source.
//
// `keep` lists the prefixes of the harness's own knobs (for example
// "GSAM_ISSUE_PERF_"); every other GSAM_* and PAPERCLIP_* variable is deleted.
export function scrubParentInstanceEnv(keep: readonly string[] = []): void {
  for (const key of Object.keys(process.env)) {
    if (/^(GSAM_|PAPERCLIP_)/.test(key) && !keep.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}
