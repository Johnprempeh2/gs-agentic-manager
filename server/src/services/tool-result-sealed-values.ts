import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { activeHeartbeatRunScratchDir } from "./run-scratch.js";

/**
 * The Netlify connection's `deploy-site` operation answers with a shell
 * command whose `--proxy-path` URL carries a signed token
 * (`https://netlify-mcp.netlify.app/proxy/<jwt>`). Result redaction masks the
 * JWT, so the agent got a command it could not run (GRE-1007).
 *
 * Before redaction, move each such URL into a 0600 file in the calling run's
 * scratch dir and replace it with `$(cat "<file>")`. The agent's shell reads
 * the token when the command runs; tool output, transcripts, audit rows and
 * comments only ever see the file path. The file goes when the run's scratch
 * dir is cleaned up.
 */
const NETLIFY_MCP_PROXY_URL_RE =
  /https:\/\/netlify-mcp\.netlify\.app\/proxy\/[^\s"'`<>\\()]*[^\s"'`<>\\().,;:]/g;

export const SEALED_VALUES_DIRNAME = ".gsam-sealed";

function collectProxyUrls(value: unknown, found: Set<string>, depth = 0) {
  if (depth > 32) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(NETLIFY_MCP_PROXY_URL_RE)) found.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProxyUrls(item, found, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectProxyUrls(item, found, depth + 1);
  }
}

function replaceProxyUrls(value: unknown, replacements: Map<string, string>, depth = 0): unknown {
  if (depth > 32) return value;
  if (typeof value === "string") {
    return value.replace(NETLIFY_MCP_PROXY_URL_RE, (url) => replacements.get(url) ?? url);
  }
  if (Array.isArray(value)) return value.map((item) => replaceProxyUrls(item, replacements, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceProxyUrls(item, replacements, depth + 1)]),
    );
  }
  return value;
}

/**
 * Returns the result with every Netlify MCP proxy URL swapped for a shell
 * read of a run-private file. Returns the input unchanged when it has no such
 * URL or the run has no local scratch dir; redaction then masks the token as
 * before, which is safe but leaves the command unusable.
 */
export async function sealToolResultProxyPaths(
  result: unknown,
  input: { runId: string | null | undefined },
): Promise<unknown> {
  const urls = new Set<string>();
  collectProxyUrls(result, urls);
  if (urls.size === 0) return result;
  const scratchDir = activeHeartbeatRunScratchDir(input.runId);
  if (!scratchDir) return result;

  const sealedDir = path.join(scratchDir, SEALED_VALUES_DIRNAME);
  await fs.mkdir(sealedDir, { recursive: true, mode: 0o700 });
  const replacements = new Map<string, string>();
  for (const url of urls) {
    const file = path.join(sealedDir, `netlify-proxy-path-${randomUUID()}`);
    await fs.writeFile(file, url, { mode: 0o600, flag: "wx" });
    replacements.set(url, `$(cat "${file}")`);
  }
  return replaceProxyUrls(result, replacements);
}
