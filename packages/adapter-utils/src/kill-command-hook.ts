import fs from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "./ssh.js";

/**
 * A Claude Code PreToolUse hook that refuses a Bash command which stops
 * processes by name or pattern. Agents run as the same OS user as the live
 * server, so a pattern can match live: on 4 Oct 2026 `pkill -f "dev-runner.ts
 * dev"` from an agent sandbox stopped live for 8.5 hours (GRE-744).
 *
 * The pkill and killall wrappers (process-kill-guard.ts) leave live out of a
 * pattern kill, but `kill` is a shell builtin, so `kill $(pgrep -f ...)` and
 * `pgrep ... | xargs kill` never reach them, nor does `/usr/bin/pkill`. This
 * hook refuses those before they run. `kill <pid>` stays allowed.
 *
 * The check is a plain scan of the command text, not a shell parser. It errs
 * towards refusing: a refused command tells the agent how to stop a process
 * safely.
 */
export const KILL_COMMAND_HOOK_FILE_NAME = "gsam-kill-command-hook.cjs";

const HOOK_SOURCE = String.raw`// GSAM kill command hook (generated; do not edit).
"use strict";

const WRAPPERS = new Set([
  "sudo", "command", "builtin", "exec", "nohup", "nice", "env", "time", "xargs", "timeout",
  "{", "}", "!", "if", "then", "else", "elif", "do", "while", "until",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "eval"]);

function unquote(token) {
  return token.replace(/^['"]+|['"]+$/g, "");
}

function isRedirect(token) {
  return /^\d*[<>]/.test(token);
}

// Returns why the command is refused, or null when it may run.
function findPatternKill(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const pieces = command.split(/\$\(|[;&|\n()\x60]+/);
  const hasKill = pieces.some((piece) => {
    const head = headOf(piece);
    return head !== null && head.name === "kill";
  });
  if (hasKill && /(^|[^A-Za-z0-9_-])(pgrep|pidof)([^A-Za-z0-9_-]|$)/.test(command)) {
    return "it signals PIDs found by pgrep or pidof, which match by name or pattern";
  }
  for (const piece of pieces) {
    const head = headOf(piece);
    if (head === null) continue;
    if (head.name === "pkill" || head.name === "killall") {
      return "it runs " + head.name + ", which matches processes by name or pattern";
    }
    if (SHELLS.has(head.name)) {
      const inner = findPatternKill(head.rest.map(unquote).filter((t) => t !== "-c").join(" "));
      if (inner) return inner;
    }
    if (head.name === "kill") {
      const reason = checkKillArgs(head.rest);
      if (reason) return reason;
    }
  }
  return null;
}

// The command name of one simple command, after assignments and wrappers.
function headOf(piece) {
  const tokens = piece.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const token = unquote(tokens[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || isRedirect(token)) {
      i += 1;
      continue;
    }
    const name = token.split("/").pop();
    if (WRAPPERS.has(name)) {
      i += 1;
      // Options of the wrapper, and the duration of timeout.
      while (i < tokens.length && (/^-/.test(tokens[i]) || (name === "timeout" && /^\d/.test(tokens[i])))) i += 1;
      continue;
    }
    return { name, rest: tokens.slice(i + 1) };
  }
  return null;
}

function checkKillArgs(args) {
  const targets = [];
  let signalSeen = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = unquote(args[i]);
    if (token === "" || isRedirect(token)) continue;
    if (token === "-l" || token === "-L") return null;
    if (token === "--") {
      signalSeen = true;
      continue;
    }
    if (!signalSeen && (token === "-s" || token === "-n")) {
      signalSeen = true;
      i += 1;
      continue;
    }
    if (!signalSeen && /^-[A-Za-z0-9+]+$/.test(token)) {
      signalSeen = true;
      continue;
    }
    targets.push(token);
  }
  if (targets.length === 0) {
    return "kill gets its targets from another command (for example xargs or $(...))";
  }
  for (const target of targets) {
    if (/^[1-9][0-9]*$/.test(target) || /^%\S+$/.test(target)) continue;
    if (/^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|!)$/.test(target)) continue;
    if (/^-/.test(target)) return "kill " + target + " signals a whole process group or every process";
    return "kill " + target + " is not a process number";
  }
  return null;
}

function refuse(reason) {
  process.stderr.write(
    "GSAM refused this command: " + reason + ".\n" +
      "Agents run as the same user as the live GS Agentic Manager server, so a name or pattern can stop live.\n" +
      "Stop a process by the PID you recorded when you started it (kill <pid>), or stop your sandbox with pnpm dev:stop.\n",
  );
  process.exit(2);
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    let event;
    try {
      event = JSON.parse(input);
    } catch {
      process.exit(0);
    }
    const command = event && event.tool_input ? event.tool_input.command : null;
    const reason = findPatternKill(command);
    if (reason) refuse(reason);
    process.exit(0);
  });
} else {
  module.exports = { findPatternKill };
}
`;

/** The hook script as written to disk. */
export function killCommandHookSource(): string {
  return HOOK_SOURCE;
}

/**
 * Writes the hook script into `dir` and returns its path. Concurrent runs may
 * write the same file, so it is replaced by rename and left alone when it is
 * already current.
 */
export async function writeKillCommandHook(dir: string): Promise<string> {
  const target = path.join(dir, KILL_COMMAND_HOOK_FILE_NAME);
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (current === HOOK_SOURCE) return target;
  await fs.mkdir(dir, { recursive: true });
  const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(staging, HOOK_SOURCE, { mode: 0o644 });
  await fs.rename(staging, target);
  return target;
}

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/** The PreToolUse entry that runs the hook with this Node binary. */
export function killCommandHookEntry(scriptPath: string, nodePath = process.execPath): HookEntry {
  return {
    matcher: "Bash",
    hooks: [{ type: "command", command: `${shellQuote(nodePath)} ${shellQuote(scriptPath)}` }],
  };
}

/**
 * Adds the hook to a Claude settings `hooks` value. An earlier copy of the
 * hook is replaced, so running this twice gives the same settings.
 */
export function withKillCommandHook(hooks: unknown, entry: HookEntry): Record<string, unknown> {
  const base =
    hooks && typeof hooks === "object" && !Array.isArray(hooks) ? { ...(hooks as Record<string, unknown>) } : {};
  const existing = Array.isArray(base.PreToolUse) ? (base.PreToolUse as HookEntry[]) : [];
  const others = existing.filter(
    (candidate) =>
      !candidate?.hooks?.some(
        (hook) => typeof hook?.command === "string" && hook.command.includes(KILL_COMMAND_HOOK_FILE_NAME),
      ),
  );
  base.PreToolUse = [...others, entry];
  return base;
}
