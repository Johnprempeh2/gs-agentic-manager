// The free-port probe and Postgres's own bind are two steps, so another
// process (a concurrent sandbox, an orphaned cluster) can take the probed port
// in between. When the bind loses that race, probe again past the lost port.
export const EMBEDDED_POSTGRES_BIND_ATTEMPTS = 5;

// A socket lock that appears between the probe and the start (a concurrent
// sandbox on the same port) loses the race the same way a TCP bind does.
export function isPortInUseFailure(logs: string[]): boolean {
  return logs.some((line) =>
    /address already in use/i.test(line) || /lock file ".*\.s\.PGSQL\.\d+\.lock" already exists/i.test(line));
}

// The TCP probe misses a stale `.s.PGSQL.<port>.lock` left by a cluster that
// was not stopped cleanly; Postgres then refuses that port (GRE-2381). Skip
// locked ports and probe again past them.
export async function findPortWithoutSocketLock(input: {
  from: number;
  detectFreePort: (from: number) => Promise<number>;
  hasSocketLock: (port: number) => boolean;
  maxLookahead?: number;
}): Promise<number> {
  const limit = input.from + (input.maxLookahead ?? 20);
  let from = input.from;
  while (from < limit) {
    const port = await input.detectFreePort(from);
    if (!input.hasSocketLock(port)) return port;
    from = port + 1;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a port without a socket lock from ${input.from} to ${limit - 1}`,
  );
}

export async function startOnFreePort(input: {
  requestedPort: number;
  findFreePort: (from: number) => Promise<number>;
  start: (port: number) => Promise<void>;
  lostBindRace: (err: unknown) => boolean;
  onRetry?: (lostPort: number, attempt: number) => void;
  maxAttempts?: number;
}): Promise<number> {
  const maxAttempts = input.maxAttempts ?? EMBEDDED_POSTGRES_BIND_ATTEMPTS;
  let from = input.requestedPort;
  for (let attempt = 1; ; attempt += 1) {
    const port = await input.findFreePort(from);
    try {
      await input.start(port);
      return port;
    } catch (err) {
      if (attempt >= maxAttempts || !input.lostBindRace(err)) throw err;
      input.onRetry?.(port, attempt);
      from = port + 1;
    }
  }
}
