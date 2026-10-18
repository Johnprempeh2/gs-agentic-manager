import { spawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

export type GuardedProcess = ReturnType<typeof spawn>;

const guardScript = fileURLToPath(new URL("./process-group-guard.mjs", import.meta.url));

/**
 * Starts `command` under process-group-guard.mjs in a new process group.
 * Stop it with stopProcessGroup(). If this process dies first, the guard sees
 * its stdin close and stops the group itself, so the command never outlives
 * the test.
 */
export function spawnInProcessGroup(
  command: string,
  args: string[],
  options: Omit<SpawnOptions, "detached" | "stdio"> = {},
): GuardedProcess {
  return spawn(process.execPath, [guardScript, command, ...args], {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Stops every process in the group started by spawnInProcessGroup(): SIGTERM,
 * then SIGKILL after `graceMs`. Resolves once the group is empty.
 */
export async function stopProcessGroup(child: GuardedProcess | null, graceMs = 10_000) {
  const pgid = child?.pid;
  if (!pgid) return;
  child.stdin?.destroy();
  signalProcessGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pgid)) {
    if (Date.now() >= deadline) {
      signalProcessGroup(pgid, "SIGKILL");
      if (Date.now() >= deadline + 5_000) {
        throw new Error(`process group ${pgid} is still alive after SIGKILL`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
