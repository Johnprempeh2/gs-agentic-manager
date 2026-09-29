import { describe, expect, it } from "vitest";
import {
  parseDarwinSharedMemory,
  reapOrphanedPostgresSharedMemory,
} from "./embedded-postgres-shared-memory.js";

// Shape of real `ipcs -m -a` output from the GRE-211 host.
const IPCS_OUTPUT = [
  "IPC status from <running system> as of Tue Sep 29 13:38:08 BST 2026",
  "T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH  SEGSZ  CPID  LPID   ATIME    DTIME    CTIME",
  "Shared Memory:",
  // live cluster: postmaster attached
  "m  65536 0x05cedf78 --rw------- me    staff me    staff      6     56   1237   1237 23:59:32 13:37:35 23:59:32",
  // orphan: no attachments, creator dead
  "m 227999746 0x0ab08d82 --rw------- me    staff me    staff      0     56  58276  58276 13:33:52 13:36:34 13:33:52",
  // detached but creator still alive (e.g. mid-restart): keep
  "m 14483460 0x0ab088d8 --rw------- me    staff me    staff      0     56  58055  58055 13:33:39 13:36:33 13:33:39",
  // another user's orphan: keep
  "m 10878981 0x0aaa4793 --rw------- other    staff other    staff      0     56  44660  44660 13:14:21 13:36:34 13:14:21",
  // not Postgres-sized (another app's persistent segment): keep
  "m 14680070 0x0ab09855 --rw------- me    staff me    staff      0   4096  58870  58870 13:34:19 13:36:34 13:34:19",
  "",
].join("\n");

const DEAD = new Set([58276, 44660, 58870]);

function run(overrides: Parameters<typeof reapOrphanedPostgresSharedMemory>[0] = {}) {
  const removed: string[] = [];
  const result = reapOrphanedPostgresSharedMemory({
    platform: "darwin",
    owner: "me",
    listSegments: () => IPCS_OUTPUT,
    isProcessAlive: (pid) => !DEAD.has(pid),
    removeSegment: (id) => void removed.push(id),
    ...overrides,
  });
  return { result, removed };
}

describe("reapOrphanedPostgresSharedMemory (GRE-211)", () => {
  it("parses shared-memory rows with size and creator pid", () => {
    expect(parseDarwinSharedMemory(IPCS_OUTPUT)[1]).toEqual({
      id: "227999746",
      owner: "me",
      attachments: 0,
      sizeBytes: 56,
      creatorPid: 58276,
    });
  });

  it("removes only this user's detached Postgres segments whose creator has exited", () => {
    const { result, removed } = run();
    expect(removed).toEqual(["227999746"]);
    expect(result).toEqual(["227999746"]);
  });

  it("does nothing off macOS", () => {
    expect(run({ platform: "linux" }).removed).toEqual([]);
  });

  it("never throws when ipcs or ipcrm fail", () => {
    expect(
      run({
        listSegments: () => {
          throw new Error("ipcs missing");
        },
      }).result,
    ).toEqual([]);
    expect(
      run({
        removeSegment: () => {
          throw new Error("EPERM");
        },
      }).result,
    ).toEqual([]);
  });
});
