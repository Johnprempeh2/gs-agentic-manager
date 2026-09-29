import { describe, expect, it, vi } from "vitest";
import {
  createMigrationStatusTracker,
  parseMigrationStatusResult,
  type MigrationStatusCommandResult,
} from "../../../scripts/dev-runner-migration-status.ts";

const failedCheck: MigrationStatusCommandResult = {
  code: 1,
  stdout: "",
  stderr: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\n",
};

function okCheck(pendingMigrations: string[]): MigrationStatusCommandResult {
  return {
    code: 0,
    stdout: `${JSON.stringify({
      status: pendingMigrations.length > 0 ? "needsMigrations" : "upToDate",
      pendingMigrations,
    })}\n`,
    stderr: "",
  };
}

function createTracker(results: MigrationStatusCommandResult[]) {
  const onFatal = vi.fn((failure: { code: number }) => {
    throw new Error(`exit ${failure.code}`);
  });
  const warn = vi.fn();
  const tracker = createMigrationStatusTracker({
    runCheck: async () => {
      const next = results.shift();
      if (!next) throw new Error("no more results");
      return next;
    },
    onFatal: onFatal as unknown as (failure: { code: number; detail: string }) => never,
    warn,
  });
  return { tracker, onFatal, warn };
}

describe("parseMigrationStatusResult", () => {
  it("reads the last JSON line past pnpm reporter noise", () => {
    expect(
      parseMigrationStatusResult({
        code: 0,
        stdout: 'WARN Unsupported engine\n{"status":"needsMigrations","pendingMigrations":["0001_a.sql"]}\n',
        stderr: "",
      }),
    ).toEqual({ ok: true, payload: { status: "needsMigrations", pendingMigrations: ["0001_a.sql"] } });
  });

  it("reports a failed command with its exit code", () => {
    expect(parseMigrationStatusResult(failedCheck)).toEqual({
      ok: false,
      failure: { code: 1, detail: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\n" },
    });
  });
});

describe("createMigrationStatusTracker", () => {
  it("exits on a failed check at startup", async () => {
    const { tracker, onFatal } = createTracker([failedCheck]);

    await expect(tracker.refresh({ fatal: true })).rejects.toThrow("exit 1");
    expect(onFatal).toHaveBeenCalledWith({ code: 1, detail: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\n" });
  });

  // GRE-166: during a release, `pnpm install` in the live checkout made the
  // periodic scan's check fail and the supervisor exited, orphaning the server.
  it("keeps running on a failed scan-time check and retries on the next scan", async () => {
    const { tracker, onFatal, warn } = createTracker([
      okCheck(["0001_a.sql"]),
      failedCheck,
      okCheck([]),
    ]);

    await tracker.refresh({ fatal: true });
    expect(tracker.pendingMigrations).toEqual(["0001_a.sql"]);
    expect(tracker.retryPending).toBe(false);

    await expect(tracker.refresh({ fatal: false })).resolves.toBeNull();
    expect(onFatal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("migration status check failed (code 1)"));
    expect(tracker.pendingMigrations).toEqual(["0001_a.sql"]);
    expect(tracker.retryPending).toBe(true);

    await expect(tracker.refresh({ fatal: false })).resolves.toEqual({ status: "upToDate", pendingMigrations: [] });
    expect(tracker.pendingMigrations).toEqual([]);
    expect(tracker.retryPending).toBe(false);
  });

  it("treats a check that cannot spawn as a scan-time failure", async () => {
    const warn = vi.fn();
    const tracker = createMigrationStatusTracker({
      runCheck: async () => {
        throw new Error("spawn pnpm ENOENT");
      },
      onFatal: (() => {
        throw new Error("should not exit");
      }) as () => never,
      warn,
    });

    await expect(tracker.refresh({ fatal: false })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn pnpm ENOENT"));
    expect(tracker.retryPending).toBe(true);
  });
});
