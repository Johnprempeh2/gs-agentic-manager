export type ProcessKill = (pid: number, signal: NodeJS.Signals) => boolean;

export function killProcessIfPresent(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL",
  kill: ProcessKill = process.kill,
): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
