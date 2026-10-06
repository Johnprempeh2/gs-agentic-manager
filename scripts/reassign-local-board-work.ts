/**
 * One-off: move open work from the legacy `local-board` user to each
 * company's primary owner (the earliest active owner that is not
 * `local-board`). For an instance that switched from `local_trusted` to
 * `authenticated` mode. Not a migration: run it by hand, once, if wanted.
 *
 * For open issues only (not done or cancelled) it moves assigneeUserId,
 * responsibleUserId, executionState.currentParticipant / returnAssignee and
 * executionPolicy stage participants; and pending asks addressed to
 * `local-board`. Companies with no real owner are skipped.
 *
 * Dry run by default; nothing is written without --apply. Running it again
 * finds nothing left to move. Take a database backup first.
 *
 *   pnpm exec tsx scripts/reassign-local-board-work.ts                 # dry run, all companies
 *   pnpm exec tsx scripts/reassign-local-board-work.ts --company <id>  # dry run, one company
 *   pnpm exec tsx scripts/reassign-local-board-work.ts --apply         # write the changes
 *
 * The database comes from DATABASE_URL, else the instance config, as the
 * server does.
 */
import { createDb, resolveEmbeddedPostgresConnectionString } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { reassignLegacyBoardWork } from "../server/src/services/legacy-board-reassignment.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || resolveEmbeddedPostgresConnectionString({ dataDir: config.embeddedPostgresDataDir, port: config.embeddedPostgresPort });
  const db = createDb(dbUrl);

  console.log(apply ? "Applying changes." : "Dry run: nothing is written. Add --apply to write.");
  const report = await reassignLegacyBoardWork(db, { apply, companyId: parseFlag("--company") });
  let total = 0;
  for (const company of report) {
    if (!company.ownerUserId) {
      console.log(`- ${company.companyName}: no real owner yet, skipped.`);
      continue;
    }
    console.log(`- ${company.companyName}: ${company.issues.length} open issue(s) and ${company.interactionCount} pending ask(s) to ${company.ownerUserId}.`);
    for (const issue of company.issues) console.log(`    ${issue.identifier ?? issue.id}`);
    total += company.issues.length + company.interactionCount;
  }
  console.log(apply ? `Done: ${total} item(s) moved.` : `Dry run: ${total} item(s) would move.`);
  process.exit(0);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Moving local-board work failed: ${message}`);
  process.exit(1);
});
