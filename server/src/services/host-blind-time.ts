/**
 * Host blind time (GRE-181).
 *
 * While the host sleeps (a closed laptop lid) or the server's event loop is
 * stalled, this process cannot record run output and cannot run its watchdogs,
 * but the wall clock keeps moving. On 28 Sep a closed lid froze the server for
 * 15-minute stretches with 2-second dark wakes between them; every wake counted
 * the frozen time as run silence and stopped runs that were not hung, and their
 * retries started in a 2-second wake and froze again.
 *
 * The tracker samples the wall clock on a short timer. A gap between samples
 * well past the timer period is blind time. Time before this process started is
 * blind as well: no output could be recorded then either. Silence measured for
 * the silent-run stop subtracts blind time, so the stop counts only time the
 * server was able to watch.
 */

export const HOST_BLIND_SAMPLE_MS = 5_000;
/** A sampler gap longer than this is blind time (12 missed samples). */
export const HOST_BLIND_GAP_MS = 60_000;
const HOST_BLIND_WINDOW_RETENTION_MS = 24 * 60 * 60 * 1000;

export type HostBlindWindow = { start: number; end: number };

export interface HostBlindTimeTracker {
  /** Record a sample now; returns the blind window this sample closed, if any. */
  sample(): HostBlindWindow | null;
  /** Blind milliseconds inside [from, to]. */
  blindMsBetween(from: number, to: number): number;
  /** When the host last came back from blind time (process start if never). */
  lastResumeAt(): number;
  /** Start the background sampler; returns a stop function. */
  start(): () => void;
}

export function createHostBlindTimeTracker(opts: {
  now?: () => number;
  startedAt?: number;
  gapMs?: number;
  sampleMs?: number;
} = {}): HostBlindTimeTracker {
  const now = opts.now ?? Date.now;
  const gapMs = opts.gapMs ?? HOST_BLIND_GAP_MS;
  const sampleMs = opts.sampleMs ?? HOST_BLIND_SAMPLE_MS;
  const startedAt = opts.startedAt ?? now();
  const windows: HostBlindWindow[] = [];
  let lastSampleAt = startedAt;

  function sample() {
    const at = now();
    let closed: HostBlindWindow | null = null;
    if (at - lastSampleAt > gapMs) {
      closed = { start: lastSampleAt, end: at };
      windows.push(closed);
    }
    if (at > lastSampleAt) lastSampleAt = at;
    while (windows.length > 0 && windows[0]!.end < at - HOST_BLIND_WINDOW_RETENTION_MS) {
      windows.shift();
    }
    return closed;
  }

  function blindMsBetween(from: number, to: number) {
    if (!(to > from)) return 0;
    let blind = from < startedAt ? Math.min(to, startedAt) - from : 0;
    for (const window of windows) {
      const overlap = Math.min(to, window.end) - Math.max(from, window.start);
      if (overlap > 0) blind += overlap;
    }
    return Math.min(blind, to - from);
  }

  function lastResumeAt() {
    return windows.length > 0 ? windows[windows.length - 1]!.end : startedAt;
  }

  function start() {
    const timer = setInterval(sample, sampleMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { sample, blindMsBetween, lastResumeAt, start };
}

/** No blind time at all: the pre-GRE-181 wall-clock behaviour. Test default. */
export const NO_HOST_BLIND_TIME: HostBlindTimeTracker = createHostBlindTimeTracker({
  startedAt: 0,
  gapMs: Number.POSITIVE_INFINITY,
});

/** The server process's tracker; `index.ts` starts its sampler. */
export const hostBlindTime = createHostBlindTimeTracker();
