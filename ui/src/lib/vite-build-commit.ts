import { execFileSync } from "node:child_process";

function parseCommit(value: string | undefined): string | null {
  const commit = value?.trim() ?? "";
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}

/** Only a full source commit may enter the public browser bundle. */
export function resolveBrowserBuildCommit(
  value: string | undefined,
  readGitCommit: () => string | undefined = () => undefined,
): string | null {
  const suppliedCommit = parseCommit(value);
  if (suppliedCommit) return suppliedCommit;
  try {
    return parseCommit(readGitCommit());
  } catch {
    return null;
  }
}

export function readBrowserBuildCommit(repositoryDirectory: string): string | null {
  return resolveBrowserBuildCommit(process.env.GSAM_BUILD_COMMIT, () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }),
  );
}

export const BUILD_INFO_FILE = "build-info.json";

/**
 * Write `build-info.json` next to the bundle so local harnesses can tell
 * which commit `ui/dist` was built from, and when.
 */
export function buildInfoPlugin(commit: string | null) {
  return {
    name: "gsam-build-info",
    apply: "build" as const,
    generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): string }) {
      this.emitFile({
        type: "asset",
        fileName: BUILD_INFO_FILE,
        source: `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`,
      });
    },
  };
}
