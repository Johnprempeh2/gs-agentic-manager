import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The harness times ui/dist, so a bundle built before a rebase or an edit
// measures a UI that is no longer in the checkout (GRE-375).

export interface BundleInfo {
  commit: string | null;
  builtAt: string;
}

export interface BundleCheck {
  ok: boolean;
  bundle: BundleInfo | null;
  head: string;
  reasons: string[];
}

// Everything the UI bundle is built from.
const SOURCE_ROOTS = ["ui/src", "ui/public", "ui/index.html", "ui/vite.config.ts", "ui/package.json", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function git(repoRoot: string, args: string[]) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function newestSourceFile(repoRoot: string, sinceMs: number): string | null {
  const stack = SOURCE_ROOTS.map((root) => path.join(repoRoot, root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (!SKIP_DIRS.has(entry)) stack.push(path.join(current, entry));
      }
    } else if (stat.mtimeMs > sinceMs) {
      return path.relative(repoRoot, current);
    }
  }
  return null;
}

export function readBundleInfo(repoRoot: string): BundleInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "ui/dist/build-info.json"), "utf8")) as BundleInfo;
  } catch {
    return null;
  }
}

export function checkBundleFreshness(repoRoot: string): BundleCheck {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const bundle = readBundleInfo(repoRoot);
  const reasons: string[] = [];
  if (!bundle) {
    reasons.push("ui/dist/build-info.json is missing, so the bundle's commit is unknown");
    return { ok: false, bundle, head, reasons };
  }
  if (bundle.commit !== head) {
    // A commit that only touched the server leaves the bundle valid.
    let uiChanged = true;
    if (bundle.commit) {
      try {
        uiChanged = git(repoRoot, ["diff", "--name-only", bundle.commit, head, "--", "ui", "packages"]) !== "";
      } catch {
        // The bundle's commit is not in this repository (for example after a rebase and gc).
      }
    }
    if (uiChanged) reasons.push(`ui/dist was built from ${bundle.commit?.slice(0, 9) ?? "an unknown commit"}, but HEAD is ${head.slice(0, 9)} and the UI sources differ`);
  }
  const edited = newestSourceFile(repoRoot, Date.parse(bundle.builtAt));
  if (edited) reasons.push(`${edited} changed after ui/dist was built (${bundle.builtAt})`);
  return { ok: reasons.length === 0, bundle, head, reasons };
}

/** Fail, or rebuild when GSAM_UX_BASELINE_BUILD=1, so the run never times a stale bundle. */
export function ensureFreshBundle(repoRoot: string, rebuild: boolean): BundleCheck {
  let check = checkBundleFreshness(repoRoot);
  if (check.ok) return check;
  if (rebuild) {
    console.log(`[ux-baseline] ui/dist is stale, rebuilding:\n  - ${check.reasons.join("\n  - ")}`);
    execFileSync("pnpm", ["--dir", "ui", "build"], { cwd: repoRoot, stdio: "inherit" });
    check = checkBundleFreshness(repoRoot);
    if (check.ok) return check;
  }
  throw new Error(
    [
      "ux-baseline: ui/dist does not match the checkout, so the run would time an old UI.",
      ...check.reasons.map((reason) => `  - ${reason}`),
      "Run `pnpm --dir ui build` (or `pnpm build`) first, or set GSAM_UX_BASELINE_BUILD=1 to rebuild automatically.",
    ].join("\n"),
  );
}
