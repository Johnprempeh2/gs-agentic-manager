// Restores one backup into a new, empty database cluster (GRE-6109). Run only
// by `gsam-aura restore`, with GSAM stopped and the old cluster already moved
// aside. Uses the bundled Postgres and the app's own restore code, so the
// Mac needs no Postgres of its own.
//
//   node restore-db.mjs <payload dir> <cluster dir> <port> <backup file>

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [payload, clusterDir, portArg, backupFile] = process.argv.slice(2);
const port = Number(portArg);
if (!payload || !clusterDir || !Number.isInteger(port) || !backupFile) {
  console.error("usage: restore-db.mjs <payload dir> <cluster dir> <port> <backup file>");
  process.exit(2);
}

const dbEntry = path.join(payload, "node_modules", "@greatstone", "db", "dist", "index.js");
const db = await import(pathToFileURL(dbEntry).href);
const pgEntry = createRequire(dbEntry).resolve("embedded-postgres");
const { default: EmbeddedPostgres } = await db.loadWithoutEmbeddedPostgresExitHooks(() => import(pathToFileURL(pgEntry).href));
await db.prepareEmbeddedPostgresNativeRuntime();

// The new cluster gets the password the server already keeps for this
// install, so the server logs in to it as before.
const password = db.resolveEmbeddedPostgresStartPassword(clusterDir);
const log = [];
const keep = (line) => { log.push(String(line)); if (log.length > 50) log.shift(); };
const cluster = new EmbeddedPostgres({
  databaseDir: clusterDir,
  user: db.EMBEDDED_POSTGRES_USER,
  password,
  port,
  persistent: true,
  // The same as the server (server/src/index.ts).
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
  postgresFlags: ["-c", "dynamic_shared_memory_type=mmap"],
  onLog: keep,
  onError: keep,
});

let started = false;
try {
  await cluster.initialise();
  await cluster.start();
  started = true;
  await db.resetPostgresDatabase(db.embeddedPostgresConnectionString({ password, port, database: "postgres" }), "paperclip");
  await db.runDatabaseRestore({
    connectionString: db.embeddedPostgresConnectionString({ password, port }),
    backupFile,
  });
  console.log(`restored ${path.basename(backupFile)}`);
} catch (error) {
  console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
  if (log.length) console.error(log.slice(-20).join("\n"));
  process.exitCode = 1;
} finally {
  if (started) await cluster.stop();
}
