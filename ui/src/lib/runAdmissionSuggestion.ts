/**
 * Suggested instance run cap (GRE-114).
 *
 * Rule: (total RAM - RAM floor) / about 500 MB per run. Runs use roughly
 * 300 to 600 MB each, so 500 MB is a middle estimate.
 */

export const MB_PER_RUN_ESTIMATE = 500;
export const RUN_CAP_MIN = 1;
export const RUN_CAP_MAX = 1000;
export const RAM_FLOOR_MAX_MB = 1_048_576;

const BYTES_PER_MB = 1024 * 1024;

export function bytesToMb(bytes: number) {
  return bytes / BYTES_PER_MB;
}

export function formatGb(bytes: number) {
  const gb = Math.round((bytes / (1024 * BYTES_PER_MB)) * 10) / 10;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function formatMbAsGb(mb: number) {
  return formatGb(mb * BYTES_PER_MB);
}

export function suggestRunCap(totalBytes: number, floorMb: number) {
  const usableMb = bytesToMb(totalBytes) - Math.max(0, floorMb);
  const runs = Math.floor(usableMb / MB_PER_RUN_ESTIMATE);
  return Math.min(RUN_CAP_MAX, Math.max(RUN_CAP_MIN, runs));
}

/** One line showing the math, e.g. "16 GB machine minus 2 GB floor, about 500 MB per run: suggested 28 runs". */
export function describeRunCapSuggestion(totalBytes: number, floorMb: number) {
  const suggested = suggestRunCap(totalBytes, floorMb);
  const floorPart = floorMb > 0 ? ` minus ${formatMbAsGb(floorMb)} floor` : "";
  return `${formatGb(totalBytes)} machine${floorPart}, about ${MB_PER_RUN_ESTIMATE} MB per run: suggested ${suggested} ${suggested === 1 ? "run" : "runs"}`;
}

/** Runs the RAM free right now could still hold above the floor. */
export function runsFreeRamCanHold(availableBytes: number, floorMb: number) {
  const headroomMb = bytesToMb(availableBytes) - Math.max(0, floorMb);
  return Math.max(0, Math.floor(headroomMb / MB_PER_RUN_ESTIMATE));
}

export function parseWholeNumber(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? parsed : null;
}
