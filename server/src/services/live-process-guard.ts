import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessKillGuard } from "@greatstone/adapter-utils/process-kill-guard";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

// The checkout this server runs from (server/src/services or
// server/dist/services, three levels down), as plugin-loader resolves it.
const SERVER_INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * What an agent run's pkill and killall must never signal: this server's
 * install, its data (GSAM_HOME, which `--data-dir` sets, and the instance
 * root), and the server process with everything above it. Agents run as the
 * same OS user, so on 4 Oct 2026 an agent's `pkill -f "dev-runner.ts dev"`
 * stopped live for 8.5 hours.
 */
export function liveProcessGuard(): ProcessKillGuard {
  return {
    protectedPaths: [SERVER_INSTALL_ROOT, resolvePaperclipHomeDir(), resolvePaperclipInstanceRoot()],
    serverPid: process.pid,
  };
}
