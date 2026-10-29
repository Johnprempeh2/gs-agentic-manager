// Operator-only, prospective R1 capture. Run only after the source-specific
// approval recorded on GRE-3269; see r1-capture.md. Never run against live.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureR1Snapshot, calculateR1 } from "./r1-snapshot.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}`);
  return args[index + 1];
};
const databaseUrl = value("--database-url");
const companyId = value("--company");
const out = resolve(value("--out"));
const parsed = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
  throw new Error("R1 capture accepts only a loopback test database");
}
if (!out.endsWith(".json")) throw new Error("--out must name a JSON file");

const root = resolve(import.meta.dirname, "../../..");
const postgres = createRequire(resolve(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  const snapshot = await sql.begin("isolation level repeatable read read only", (tx) => captureR1Snapshot(tx, companyId));
  const r1 = calculateR1(snapshot, companyId);
  const result = { schema: "gsam.r1-snapshot/v1", companyId, snapshotAt: new Date(snapshot.snapshotAt).toISOString(), windowDays: 7, r1, snapshot };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`R1 weekly=${r1.weekly}; total=${r1.total}; snapshotAt=${result.snapshotAt}; saved ${out}`);
} finally {
  await sql.end();
}
