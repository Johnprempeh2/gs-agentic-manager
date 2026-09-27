import { useSecondTick } from "@/hooks/useSecondTick";

/** A step shows its own timer only once it has run this long; quick steps stay quiet. */
export const STEP_ELAPSED_THRESHOLD_MS = 10_000;

export function formatStepElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * How long the running step has taken so far. A long write or command
 * otherwise looks identical to a stalled one: the provider does not stream a
 * tool's input while the model is still producing it.
 */
export function useRunningStepElapsed(startedAt: string | undefined, running: boolean): string | null {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const measurable = running && Number.isFinite(startedAtMs);
  useSecondTick(measurable);
  if (!measurable) return null;
  const elapsedMs = Date.now() - startedAtMs;
  return elapsedMs >= STEP_ELAPSED_THRESHOLD_MS ? formatStepElapsed(elapsedMs) : null;
}
