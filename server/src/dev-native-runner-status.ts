import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  closeRegisteredClients,
  createDb,
  heartbeatRuns,
  nativeRunFinalizations,
} from "@greatstone/db";
import { resolveMigrationConnection } from "@greatstone/db/migration-runtime";

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection();
  const db = createDb(connection.connectionString, { maxConnections: 1 });

  try {
    const persistedActiveNativeRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.runtimeMode, "native"),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
    const persistedRetryableFailedNativeRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(
        nativeRunFinalizations,
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      )
      .where(
        and(
          eq(heartbeatRuns.runtimeMode, "native"),
          eq(heartbeatRuns.status, "failed"),
          eq(nativeRunFinalizations.phase, "retryable_failure"),
          isNull(nativeRunFinalizations.resultId),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
    const persistedNativeRun =
      persistedActiveNativeRun || persistedRetryableFailedNativeRun;

    console.log(
      JSON.stringify({
        // Greatstone (GRE-1436): the Runner is always on, so dev always needs runnerd.
        nativeRunnerRequired: true,
        rolloutEnabled: true,
        persistedNativeRun,
        persistedActiveNativeRun,
        persistedRetryableFailedNativeRun,
      }),
    );
  } finally {
    await closeRegisteredClients(connection.connectionString);
    await connection.stop();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
