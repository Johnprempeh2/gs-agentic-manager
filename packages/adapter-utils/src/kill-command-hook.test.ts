import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KILL_COMMAND_HOOK_FILE_NAME,
  killCommandHookEntry,
  withKillCommandHook,
  writeKillCommandHook,
} from "./kill-command-hook.js";

let dir: string;
let scriptPath: string;
let findPatternKill: (command: string) => string | null;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kill-command-hook-"));
  scriptPath = await writeKillCommandHook(dir);
  ({ findPatternKill } = createRequire(import.meta.url)(scriptPath));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function runHook(command: string) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

describe("kill command hook", () => {
  it.each([
    'pkill -f "dev-runner.ts dev"',
    "killall node",
    "/usr/bin/pkill -f tsx",
    "sudo pkill node",
    "cd tmp && pkill -f server",
    "kill $(pgrep -f dev-runner)",
    "kill -9 $(pgrep -f 'dev-runner.ts dev')",
    "pgrep -f dev-runner | xargs kill",
    "pgrep -f dev-runner | xargs -r kill -TERM",
    "ps aux | grep tsx | awk '{print $2}' | xargs kill",
    "pids=$(pgrep -f dev-runner); kill $pids",
    "kill `pgrep node`",
    "kill node",
    "kill -9 -1",
    "kill -- -1234",
    'bash -c "pkill -f dev-runner"',
    "timeout 5 pkill -f x",
  ])("refuses %s", (command) => {
    expect(findPatternKill(command)).not.toBeNull();
    const result = runHook(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GSAM refused this command");
    expect(result.stderr).toContain("pnpm dev:stop");
  });

  it.each([
    "kill 12345",
    "kill -TERM 12345 67890",
    "kill -9 12345",
    "kill -s TERM 12345",
    "kill -0 12345 2>/dev/null && echo alive",
    'kill "$PID"',
    "kill ${SERVER_PID}",
    "kill $!",
    "kill %1",
    "kill -l",
    "pnpm dev:stop",
    "pgrep -f dev-runner",
    'echo "kill node"',
    "git log --grep pkill",
    "ls -la",
  ])("allows %s", (command) => {
    expect(findPatternKill(command)).toBeNull();
    const result = runHook(command);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("lets other tools and unreadable input through", () => {
    const other = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } }),
      encoding: "utf8",
    });
    expect(other.status).toBe(0);
    const garbage = spawnSync(process.execPath, [scriptPath], { input: "not json", encoding: "utf8" });
    expect(garbage.status).toBe(0);
  });

  it("adds the hook once to existing settings hooks", () => {
    const entry = killCommandHookEntry("/state/hooks/" + KILL_COMMAND_HOOK_FILE_NAME, "/usr/bin/node");
    const userHook = { matcher: "Edit", hooks: [{ type: "command", command: "lint" }] };
    const once = withKillCommandHook({ PreToolUse: [userHook], Stop: [] }, entry);
    const twice = withKillCommandHook(once, entry);
    expect(twice).toEqual({ PreToolUse: [userHook, entry], Stop: [] });
    expect(entry.hooks?.[0]?.command).toBe(`'/usr/bin/node' '/state/hooks/${KILL_COMMAND_HOOK_FILE_NAME}'`);
  });
});
