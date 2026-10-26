/** Wait for an agent-declared critical section, bounded to two minutes. */
export async function waitForCorrectionSafePoint(input: {
  isProtected: () => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.maxWaitMs ?? 120_000);
  while (await input.isProtected()) {
    const remaining = deadline - now();
    if (remaining <= 0) return "timed_out" as const;
    await sleep(Math.min(1_000, remaining));
  }
  return "safe" as const;
}
