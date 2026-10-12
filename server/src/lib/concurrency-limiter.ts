/**
 * Caps how many callers may run a section at once. Waiters queue in memory in
 * arrival order and hold nothing else (in particular, no pooled database
 * connection) until a slot is free.
 */
export function createConcurrencyLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive integer");
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter so that it cannot be taken
      // by a later caller in between.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    };
  }

  return {
    async run<T>(section: () => Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        return await section();
      } finally {
        release();
      }
    },
  };
}
