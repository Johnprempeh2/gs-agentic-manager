/**
 * A queued run held by the instance run-admission guard (GRE-105/GRE-198)
 * carries a runtime status line such as
 * "Waiting: low memory (1.6 GB free, floor 2 GB)". Such a run is not working,
 * so UI surfaces show this line instead of a live/working state.
 */
export function runAdmissionWaitMessage(run: {
  status: string;
  currentStatusMessage?: string | null;
}): string | null {
  if (run.status !== "queued") return null;
  const message = run.currentStatusMessage?.trim();
  return message && message.startsWith("Waiting:") ? message : null;
}
