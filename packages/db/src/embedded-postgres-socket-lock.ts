import { existsSync } from "node:fs";
import path from "node:path";

// The embedded-postgres binaries keep their compiled-in socket directory.
export const EMBEDDED_POSTGRES_SOCKET_DIR = "/tmp";

// A cluster that was killed without a clean stop leaves `.s.PGSQL.<port>.lock`
// behind. When its PID is later reused by another process, Postgres treats the
// lock as live and refuses to start on that port, even though nothing listens
// on it over TCP (GRE-2381). A port with any socket lock is not free for us; we
// never remove the lock, since it may belong to a live cluster.
export function hasEmbeddedPostgresSocketLock(
  port: number,
  options: { socketDir?: string; platform?: NodeJS.Platform } = {},
): boolean {
  if ((options.platform ?? process.platform) === "win32") return false;
  const socketDir = options.socketDir ?? EMBEDDED_POSTGRES_SOCKET_DIR;
  return existsSync(path.join(socketDir, `.s.PGSQL.${port}.lock`));
}
