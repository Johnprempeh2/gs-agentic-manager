// The free-port probe and Postgres's own bind are two steps, so another
// process (a concurrent sandbox, an orphaned cluster) can take the probed port
// in between. When the bind loses that race, probe again past the lost port.
export const EMBEDDED_POSTGRES_BIND_ATTEMPTS = 5;

export function isPortInUseFailure(logs: string[]): boolean {
  return logs.some((line) => /address already in use/i.test(line));
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
