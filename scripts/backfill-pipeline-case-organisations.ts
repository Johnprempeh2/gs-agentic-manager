// GRE-1478 / GRE-1538: link every existing case, in every pipeline, to an
// organisation record. Names are matched to existing records; a card that
// matches none gets a new record and is listed so John can check it.
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
      `- ${company.id}: ${result.casesLinked} cases linked across ${result.pipelines} pipeline(s), `
        + `${result.organisationsCreated} organisations created, ${result.contactsCopied} contacts copied`,
    );
    if (result.unmatched.length > 0) {
      console.log(`  ${result.unmatched.length} card(s) matched no existing organisation:`);
      for (const card of result.unmatched) {
        const outcome = card.createdOrganisationId
          ? `new record ${card.createdOrganisationId}`
          : "NOT LINKED: blank title, set the organisation by hand";
        console.log(`  - [${card.pipelineKey}] ${card.caseKey} "${card.title}": ${outcome}`);
      }
    }
  }
  console.log("Case organisation backfill complete.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Case organisation backfill failed: ${message}`);
  process.exitCode = 1;
});
