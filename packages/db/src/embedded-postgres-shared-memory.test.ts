import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  isProcessAlive,
  parseIpcsSharedMemory,
  reapOrphanedEmbeddedPostgresSharedMemory,
} from "./embedded-postgres-shared-memory.js";

// Trimmed real `ipcs -m -a` output from macOS.
const IPCS_OUTPUT = `IPC status from <running system> as of Tue Sep 29 12:00:00 BST 2026
T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH  SEGSZ  CPID  LPID ATIME    DTIME    CTIME
Shared Memory:
m  65536 0x0052e2c1 --rw------- ridge    staff    ridge    staff      0     56  1111  1111 12:00:00 12:00:00 12:00:00
m  65537 0x0052e6a9 --rw------- ridge    staff    ridge    staff      6     56  2222  2230 12:00:00 12:00:00 12:00:00
m  65538 0x0052ea91 --rw------- ridge    staff    ridge    staff      0     56  3333  3333 12:00:00 12:00:00 12:00:00
m  65539 0x0052ee79 --rw------- other    staff    other    staff      0     56  4444  4444 12:00:00 12:00:00 12:00:00
m  65540 0x0052f261 --rw------- ridge    staff    ridge    staff      2     56  5555  5555 12:00:00 12:00:00 12:00:00
`;

describe("embedded Postgres SysV shared-memory reaper (GRE-211)", () => {
  it("parses only shared-memory rows", () => {
    expect(parseIpcsSharedMemory(IPCS_OUTPUT)).toEqual([
      { id: "65536", owner: "ridge", attachments: 0, creatorPid: 1111 },
      { id: "65537", owner: "ridge", attachments: 6, creatorPid: 2222 },
      { id: "65538", owner: "ridge", attachments: 0, creatorPid: 3333 },
      { id: "65539", owner: "other", attachments: 0, creatorPid: 4444 },
      { id: "65540", owner: "ridge", attachments: 2, creatorPid: 5555 },
    ]);
  });

  it("removes only our unattached segments whose creator is dead", () => {
    const removed: string[] = [];
    const alive = new Set([2222, 3333]);
    const result = reapOrphanedEmbeddedPostgresSharedMemory({
      platform: "darwin",
      owner: "ridge",
      listSegments: () => IPCS_OUTPUT,
      removeSegment: (id) => removed.push(id),
      isAlive: (pid) => alive.has(pid),
    });
    // 65537: live cluster. 65538: creator alive. 65539: other user.
    // 65540: dead creator but still attached by surviving backends.
    expect(result).toEqual(["65536"]);
    expect(removed).toEqual(["65536"]);
  });

  it("is a no-op off macOS and never throws", () => {
    expect(
      reapOrphanedEmbeddedPostgresSharedMemory({
        platform: "linux",
        listSegments: () => {
          throw new Error("should not run");
        },
      }),
    ).toEqual([]);
    expect(
      reapOrphanedEmbeddedPostgresSharedMemory({
        platform: "darwin",
        listSegments: () => {
          throw new Error("ipcs missing");
        },
      }),
    ).toEqual([]);
    expect(
      reapOrphanedEmbeddedPostgresSharedMemory({
        platform: "darwin",
        owner: "ridge",
        listSegments: () => IPCS_OUTPUT,
        removeSegment: () => {
          throw new Error("EINVAL");
        },
        isAlive: () => false,
      }),
    ).toEqual([]);
  });

  // Reproduces the leak end to end: a sandbox process and its cluster are
  // killed, the segment is left behind, and the pre-start step that every
  // embedded cluster runs frees it.
  it.runIf(process.platform === "darwin")(
    "frees the segment a SIGKILLed embedded cluster leaves behind",
    async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-shm-leak-"));
      const starter = spawn(
        process.execPath,
        [fileURLToPath(new URL("./__fixtures__/start-embedded-postgres-cluster.mjs", import.meta.url)), dataDir, String(await freePort())],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let postmasterPid = 0;
      try {
        const [line] = (await once(createInterface({ input: starter.stdout! }), "line")) as [string];
        const started = JSON.parse(line) as { pid: number; shmId: string };
        postmasterPid = started.pid;
        expect(segment(started.shmId)?.attachments).toBeGreaterThan(0);

        starter.kill("SIGKILL");
        process.kill(postmasterPid, "SIGKILL");
        // Backends notice postmaster death and detach shortly after.
        await waitFor(() => segment(started.shmId)?.attachments === 0 && !isProcessAlive(postmasterPid));
        expect(segment(started.shmId)).toBeDefined(); // leaked

        await prepareEmbeddedPostgresNativeRuntime();

        expect(segment(started.shmId)).toBeUndefined();
      } finally {
        starter.kill("SIGKILL");
        if (postmasterPid && isProcessAlive(postmasterPid)) process.kill(postmasterPid, "SIGKILL");
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

function segment(id: string) {
  return parseIpcsSharedMemory(execFileSync("ipcs", ["-m", "-a"], { encoding: "utf8" })).find(
    (s) => s.id === id,
  );
}

async function waitFor(check: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the killed cluster to exit");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
