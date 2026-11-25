#!/usr/bin/env node
/**
 * fetch-runner-binary.mjs
 *
 * Downloads the prebuilt native runner (paperclip-runnerd) for a GSAM release
 * and checks it against the release's SHA256SUMS, so an install never needs
 * Rust or a C toolchain. .github/workflows/runner-binaries.yml attaches the
 * binaries to every live-* release. No dependencies: it runs right after
 * Node.js is installed.
 *
 *   node scripts/fetch-runner-binary.mjs --tag live-2026-11-25.1 --dest <folder>
 *
 * Prints the binary's path. Exits 1 (and prints why) when the release has no
 * binary for this computer or the download does not match its sum; the caller
 * then falls back to building from source (the dev runner does that when
 * GSAM_RUNNER_BINARY is not set).
 *
 * GSAM_RUNNER_DOWNLOAD_URL overrides the download base (tests, mirrors):
 * <base>/<tag>/<asset> and <base>/<tag>/SHA256SUMS.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_DOWNLOAD_URL = "https://github.com/Johnprempeh2/gs-agentic-manager/releases/download";

/** The release asset for a platform and CPU, or null when none is built for it. */
export function runnerAssetName(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "paperclip-runnerd-windows-x64.exe";
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `paperclip-runnerd-macos-${arch}`;
  return null;
}

/** The sum for `asset` in a SHA256SUMS file (`<hex>  <name>` lines), or null. */
export function expectedSum(sums, asset) {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  return null;
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads, checks and installs the binary; returns its path. Already there and matching: no download. */
export async function fetchRunnerBinary({ tag, dest, baseUrl = process.env.GSAM_RUNNER_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL, platform = process.platform, arch = process.arch }) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag ?? "")) throw new Error(`not a release tag: ${tag}`);
  const asset = runnerAssetName(platform, arch);
  if (!asset) throw new Error(`no prebuilt runner for ${platform}-${arch}`);
  const base = `${baseUrl.replace(/\/+$/, "")}/${tag}`;
  const sum = expectedSum((await download(`${base}/SHA256SUMS`)).toString("utf8"), asset);
  if (!sum) throw new Error(`the ${tag} release lists no sum for ${asset}`);
  const target = path.join(dest, platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd");
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (existsSync(target) && sha256(readFileSync(target)) === sum) return target;
  const bytes = await download(`${base}/${asset}`);
  const actual = sha256(bytes);
  if (actual !== sum) throw new Error(`${asset} does not match its SHA-256 (expected ${sum}, got ${actual}); not installed`);
  mkdirSync(dest, { recursive: true });
  const partial = `${target}.partial`;
  writeFileSync(partial, bytes);
  if (platform !== "win32") chmodSync(partial, 0o755);
  rmSync(target, { force: true });
  renameSync(partial, target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tag: { type: "string" }, dest: { type: "string" } } });
  try {
    if (!values.dest) throw new Error("--dest is required");
    process.stdout.write(`${await fetchRunnerBinary({ tag: values.tag, dest: path.resolve(values.dest) })}\n`);
  } catch (error) {
    process.stdout.write(`prebuilt runner not installed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
