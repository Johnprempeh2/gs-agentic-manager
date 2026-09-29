export type MigrationStatusPayload = { status?: string; pendingMigrations?: string[] };

export type MigrationStatusCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type MigrationStatusFailure = { code: number; detail: string };

const migrationStatusCommand = "pnpm --filter @greatstone/db exec tsx src/migration-status.ts --json";

export function parseMigrationStatusResult(
  result: MigrationStatusCommandResult,
): { ok: true; payload: MigrationStatusPayload } | { ok: false; failure: MigrationStatusFailure } {
  if (result.code !== 0) {
    return {
      ok: false,
      failure: {
        code: result.code,
        detail:
          result.stderr ||
          result.stdout ||
          `[paperclip] Command failed with code ${result.code}: ${migrationStatusCommand}\n`,
      },
    };
  }

  // pnpm can interleave its own reporter lines (e.g. "Unsupported engine"
  // warnings) into stdout, so parse the last line that is a JSON object
  // instead of trusting the whole stream.
  const jsonLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (let index = jsonLines.length - 1; index >= 0; index -= 1) {
    try {
      return { ok: true, payload: JSON.parse(jsonLines[index]) as MigrationStatusPayload };
    } catch {
      // keep scanning earlier JSON-looking lines
    }
  }
  return {
    ok: false,
    failure: {
      code: 1,
      detail: result.stderr || result.stdout || "[paperclip] migration-status returned invalid JSON payload\n",
    },
  };
}

// Tracks pending migrations for the dev-runner supervisor. A failed check is
// fatal only when the caller says so (startup preflight). Once the server child
// is running, exiting would orphan it and leave a stale status file behind
// (GRE-166: a release's `pnpm install` made the scan-time check fail), so later
// failures warn, keep the last known state and ask the next scan to retry.
export function createMigrationStatusTracker(deps: {
  runCheck: () => Promise<MigrationStatusCommandResult>;
  onFatal: (failure: MigrationStatusFailure) => never;
  warn: (message: string) => void;
}) {
  let pendingMigrations: string[] = [];
  let retryPending = false;

  return {
    get pendingMigrations() {
      return pendingMigrations;
    },
    get retryPending() {
      return retryPending;
    },
    async refresh(options: { fatal: boolean }): Promise<MigrationStatusPayload | null> {
      let result: MigrationStatusCommandResult;
      try {
        result = await deps.runCheck();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { code: 1, stdout: "", stderr: `[paperclip] migration status check could not run: ${message}\n` };
      }
      const parsed = parseMigrationStatusResult(result);
      if (!parsed.ok) {
        if (options.fatal) deps.onFatal(parsed.failure);
        retryPending = true;
        deps.warn(
          `[paperclip] migration status check failed (code ${parsed.failure.code}); keeping the server running and retrying on the next scan\n${parsed.failure.detail}`,
        );
        return null;
      }
      retryPending = false;
      const payload = parsed.payload;
      pendingMigrations =
        payload.status === "needsMigrations" && Array.isArray(payload.pendingMigrations)
          ? payload.pendingMigrations.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
          : [];
      return payload;
    },
  };
}
