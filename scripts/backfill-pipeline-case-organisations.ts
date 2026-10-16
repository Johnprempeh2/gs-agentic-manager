// GRE-1478: link existing client cases to organisation records and turn the
// "requires an organisation" rule on for the Client journey pipeline.
// Dry run by default; pass --apply to write. Run on live only in John's release.
//   pnpm case-organisations:backfill [--company <id>] [--pipeline <key>] [--apply]
import { companies, createDb, resolveEmbeddedPostgresConnectionString } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { backfillCaseOrganisations } from "../server/src/services/pipeline-case-organisation-backfill.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || resolveEmbeddedPostgresConnectionString({ dataDir: config.embeddedPostgresDataDir, port: config.embeddedPostgresPort });

  const db = createDb(dbUrl);
  const dryRun = !process.argv.includes("--apply");
  const pipelineKey = parseFlag("--pipeline");
  const companyId = parseFlag("--company");
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  console.log(dryRun ? "Dry run: nothing is written. Pass --apply to write." : "Applying changes.");
  for (const company of companyRows) {
    const result = await backfillCaseOrganisations(db, {
      companyId: company.id,
      pipelineKeys: pipelineKey ? [pipelineKey] : undefined,
      dryRun,
    });
    if (result.pipelines === 0) continue;
    console.log(
      `- ${company.id}: ${result.casesLinked} cases linked, ${result.organisationsCreated} organisations created, `
        + `${result.contactsCopied} contacts copied, rule on for ${result.pipelines} pipeline(s)`,
    );
  }
  console.log("Case organisation backfill complete.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Case organisation backfill failed: ${message}`);
  process.exitCode = 1;
});
