#!/usr/bin/env node
// Fetches the system libraries Playwright's Chromium needs without root
// (GRE-1065). Hosts like WSL Ubuntu lack libnspr4/libnss3/libasound2 and agents
// have no sudo, so the missing ones are pulled with `apt-get download` and
// unpacked with `dpkg-deb -x` into one folder for the whole account, then put
// on LD_LIBRARY_PATH. Used by preview-shot.mjs and tests/metrics-budgets/s2-check.mjs.
//
//   node scripts/chromium-libs.mjs     # fetch if needed, print the LD_LIBRARY_PATH to use
//
// The folder lives in the account's Playwright browsers folder, not a worktree,
// so every worktree and agent run shares one copy. It is named gs-chromium-libs,
// not chromium-libs: Playwright deletes unknown "chromium-*" folders there as
// stale browsers.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// Library file -> Debian packages that ship it (first that downloads wins;
// Ubuntu 24.04 renamed libasound2 to libasound2t64).
export const LIB_PACKAGES = {
  "libnspr4.so": ["libnspr4"],
  "libnss3.so": ["libnss3"],
  "libnssutil3.so": ["libnss3"],
  "libsmime3.so": ["libnss3"],
  "libasound.so.2": ["libasound2t64", "libasound2"],
};

const MULTIARCH = { x64: "x86_64-linux-gnu", arm64: "aarch64-linux-gnu" };

// The account's own browsers folder. Agent runs have a temp HOME, so this uses
// the passwd home rather than $HOME (same as greatstone-preview.sh).
export function accountBrowsersPath() {
  const home = userInfo().homedir;
  return process.platform === "darwin" ? join(home, "Library", "Caches", "ms-playwright") : join(home, ".cache", "ms-playwright");
}

export function libPaths(libRoot = join(accountBrowsersPath(), "gs-chromium-libs")) {
  return { libRoot, libDir: join(libRoot, "root", "usr", "lib", MULTIARCH[process.arch] ?? MULTIARCH.x64) };
}

export function headlessShell(browsersPath) {
  const dir = existsSync(browsersPath)
    ? readdirSync(browsersPath).filter((name) => name.startsWith("chromium_headless_shell-")).sort().pop()
    : undefined;
  const binary = dir && join(browsersPath, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
  return binary && existsSync(binary) ? binary : undefined;
}

export function parseLdd(output) {
  return [...output.matchAll(/^\s*(\S+) => not found/gm)].map((match) => match[1]);
}

// Missing library files -> the package choices to download, and any library
// no known package supplies.
export function packagesFor(missing) {
  const unknown = missing.filter((lib) => !LIB_PACKAGES[lib]);
  const seen = new Set();
  const packages = [];
  for (const lib of missing) {
    const options = LIB_PACKAGES[lib];
    if (!options || seen.has(options.join(" "))) continue;
    seen.add(options.join(" "));
    packages.push(options);
  }
  return { packages, unknown };
}

const system = {
  ldd: (binary, env) => parseLdd(execFileSync("ldd", [binary], { encoding: "utf8", env: { ...process.env, ...env } })),
  download: (name, cwd) => spawnSync("apt-get", ["download", name], { cwd, stdio: "ignore" }).status === 0,
  extract: (deb, into) => execFileSync("dpkg-deb", ["-x", deb, into]),
};

// Returns { LD_LIBRARY_PATH } that lets `binary` load, fetching what is
// missing. Throws a one-line reason when the no-root fetch cannot fix it; only
// then does the host need `sudo npx playwright install-deps chromium`.
export function ensureChromiumLibs(binary, { libRoot, ldPath = process.env.LD_LIBRARY_PATH, sys = system } = {}) {
  const paths = libPaths(libRoot);
  const env = { LD_LIBRARY_PATH: [paths.libDir, ldPath].filter(Boolean).join(":") };
  let missing = sys.ldd(binary, env);
  if (missing.length === 0) return env;
  const { packages, unknown } = packagesFor(missing);
  if (unknown.length) throw new Error(`Chromium needs ${unknown.join(", ")}, which the no-root fetch does not know`);
  mkdirSync(paths.libRoot, { recursive: true });
  const debs = mkdtempSync(join(paths.libRoot, "debs-"));
  try {
    for (const options of packages) {
      if (!options.some((name) => sys.download(name, debs))) throw new Error(`could not download ${options.join(" or ")} with apt-get`);
    }
    for (const deb of readdirSync(debs).filter((name) => name.endsWith(".deb"))) sys.extract(join(debs, deb), join(paths.libRoot, "root"));
  } finally {
    rmSync(debs, { recursive: true, force: true });
  }
  missing = sys.ldd(binary, env);
  if (missing.length) throw new Error(`Chromium still misses ${missing.join(", ")} after the no-root fetch into ${paths.libDir}`);
  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const binary = process.platform === "linux" ? headlessShell(process.env.PLAYWRIGHT_BROWSERS_PATH || accountBrowsersPath()) : undefined;
  if (!binary) {
    console.error("chromium-libs: no Linux chrome-headless-shell found; nothing to fetch.");
  } else {
    try {
      console.log(ensureChromiumLibs(binary).LD_LIBRARY_PATH);
    } catch (error) {
      console.error(`chromium-libs: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
