/**
 * Runs one pull at a time. A request that lands during a pull is kept and run once afterwards:
 * every site pinged meanwhile is pulled together, and a full pull covers them all.
 * `siteIds` undefined means every site.
 */
export function serialPulls(pull: (siteIds?: string[]) => Promise<void>) {
  let running = false;
  let full = false;
  const pending = new Set<string>();
  const run = async (siteIds?: string[]): Promise<void> => {
    if (running) {
      if (siteIds) siteIds.forEach((id) => pending.add(id));
      else full = true;
      return;
    }
    running = true;
    try {
      await pull(siteIds);
    } finally {
      running = false;
      const next = full ? undefined : [...pending];
      const queued = full || pending.size > 0;
      full = false;
      pending.clear();
      if (queued) void run(next);
    }
  };
  return run;
}
