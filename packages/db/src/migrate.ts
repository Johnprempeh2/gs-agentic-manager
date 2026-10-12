import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const before = await inspectMigrations(resolved.connectionString);
    if (before.status === "upToDate") {
      console.log("No pending migrations");
      return;
    }

    // scripts/greatstone-preview.sh reads the names from this line (GRE-902).
    console.log(
      `Applying ${before.pendingMigrations.length} pending migration(s): ${before.pendingMigrations.join(", ")}`,
    );
    await applyPendingMigrations(resolved.connectionString);

    const after = await inspectMigrations(resolved.connectionString);
    if (after.status !== "upToDate") {
      throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
    }
    console.log("Migrations complete");
  } finally {
    await resolved.stop();
  }
}

await main();
