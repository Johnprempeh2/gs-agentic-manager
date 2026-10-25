import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasEmbeddedPostgresSocketLock } from "./embedded-postgres-socket-lock.js";
import { findAvailablePort } from "./migration-runtime.js";

async function freeTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("embedded Postgres socket lock (GRE-2381)", () => {
  let socketDir: string;

  beforeEach(() => {
    socketDir = mkdtempSync(path.join(os.tmpdir(), "gsam-socket-lock-"));
  });

  afterEach(() => {
    rmSync(socketDir, { recursive: true, force: true });
  });

  it("reports a planted lock file only for its own port", () => {
    writeFileSync(path.join(socketDir, ".s.PGSQL.54330.lock"), "961\n/gone/data\n");

    expect(hasEmbeddedPostgresSocketLock(54330, { socketDir })).toBe(true);
    expect(hasEmbeddedPostgresSocketLock(54331, { socketDir })).toBe(false);
    expect(hasEmbeddedPostgresSocketLock(54330, { socketDir, platform: "win32" })).toBe(false);
  });

  it("findAvailablePort skips a TCP-free port with a stale socket lock", async () => {
    const port = await freeTcpPort();
    expect(await findAvailablePort(port, { socketDir })).toBe(port);

    writeFileSync(path.join(socketDir, `.s.PGSQL.${port}.lock`), "961\n/gone/data\n");

    const selected = await findAvailablePort(port, { socketDir });
    expect(selected).toBeGreaterThan(port);
  });
});
