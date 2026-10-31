import { readFile, writeFile } from "node:fs/promises";
import { dryRunClientPeople } from "../src/services/client-people-dry-run.js";

const [snapshotPath, reportPath] = process.argv.slice(2);
if (!snapshotPath || !reportPath) {
  console.error("Usage: pnpm exec tsx server/scripts/client-people-dry-run.ts <snapshot.json> <report.json>");
  process.exitCode = 2;
} else {
  try {
    const snapshot: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
    const report = dryRunClientPeople(snapshot as Parameters<typeof dryRunClientPeople>[0]);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ total: report.total, ...report.counts,
      distinctWebsiteUsersToCreate: report.distinctWebsiteUsersToCreate, reviewList: report.reviewList.length }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
