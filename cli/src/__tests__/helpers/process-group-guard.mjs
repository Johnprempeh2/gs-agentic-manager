// Runs `node process-group-guard.mjs <command> [...args]` as the leader of its own
// process group (spawn it with `detached: true`). The command and everything it
// starts stay in that group, so one signal to the group stops the whole tree.
//
// The guard stops the group when:
// - it gets SIGTERM or SIGINT (normal teardown), or
// - its stdin closes, which happens when the test worker that spawned it dies
//   without running teardown (crash, SIGKILL, lane stopped).
//
// It sends SIGTERM to the group and waits up to GSAM_GUARD_GRACE_MS for the
// command to exit. When the command exits, for any reason, the guard sends
// SIGKILL to the group (itself included) so no child or grandchild is left.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: process-group-guard.mjs <command> [...args]");
  process.exit(2);
}

const graceMs = Number(process.env.GSAM_GUARD_GRACE_MS ?? "5000");
let stopping = false;

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`[process-group-guard] ${command} exited (code ${code}, signal ${signal})`);
  }
  signalGroup("SIGKILL");
});
child.on("error", (error) => {
  console.error(`[process-group-guard] could not start ${command}: ${error.message}`);
  signalGroup("SIGKILL");
});

function stopGroup() {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), graceMs);
}

process.on("SIGTERM", stopGroup);
process.on("SIGINT", stopGroup);
process.stdin.on("end", stopGroup);
process.stdin.on("close", stopGroup);
process.stdin.on("error", stopGroup);
process.stdin.resume();
