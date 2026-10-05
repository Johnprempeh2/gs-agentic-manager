// Ports for a new client instance (GRE-706, register row 62).
// A stopped instance does not hold its ports, so `create` also skips the ports
// that sibling instances (other folders beside --root) wrote in client-instance.json.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const STATE_FILE = "client-instance.json";

export interface PortClaim {
  root: string;
  port: number;
  dbPort: number;
}

/** The ports each sibling instance beside `root` claims. A folder without a readable state file claims nothing. */
export function siblingPortClaims(root: string): PortClaim[] {
  const parent = path.dirname(root);
  if (!existsSync(parent)) return [];
  const claims: PortClaim[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const dir = path.join(parent, entry.name);
    if (!entry.isDirectory() || dir === root) continue;
    const file = path.join(dir, STATE_FILE);
    if (!existsSync(file)) continue;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown; dbPort?: unknown };
      if (Number.isInteger(state.port) && Number.isInteger(state.dbPort)) {
        claims.push({ root: dir, port: state.port as number, dbPort: state.dbPort as number });
      }
    } catch {
      // not a state file we can read: no claim
    }
  }
  return claims;
}

function claimant(claims: PortClaim[], port: number): string | null {
  return claims.find((c) => c.port === port || c.dbPort === port)?.root ?? null;
}

type FirstFree = (from: number, to: number, skip: Set<number>) => Promise<number>;

/** Explicit ports are kept unless a sibling claims them; otherwise the first free port that no sibling claims. */
export async function choosePorts(opts: {
  port?: number;
  dbPort?: number;
  claims: PortClaim[];
  firstFree: FirstFree;
}): Promise<{ port: number; dbPort: number }> {
  const { claims, firstFree } = opts;
  for (const [value, label] of [[opts.port, "--port"], [opts.dbPort, "--db-port"]] as const) {
    if (value === undefined) continue;
    const owner = claimant(claims, value);
    if (owner) throw new Error(`${label} ${value} is claimed by the instance at ${owner}; pick another port`);
  }
  const claimed = new Set(claims.flatMap((c) => [c.port, c.dbPort]));
  const port = opts.port ?? (await firstFree(3300, 3399, claimed));
  const dbPort = opts.dbPort ?? (await firstFree(55400, 55499, new Set([...claimed, port])));
  return { port, dbPort };
}
