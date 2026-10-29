// Operator-only, prospective R1 capture. Run only after the source-specific
// approval recorded on GRE-3269; see r1-capture.md. Never run against live.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureR1Snapshot, summariseR1 } from "./r1-snapshot.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}`);
  return args[index + 1];
};
const databaseUrl = value("--database-url");
const companyId = value("--company");
const sourceRef = value("--source-ref");
const sourceCapturedAt = value("--source-captured-at");
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
  const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const snapshot = await captureR1Snapshot(tx, companyId, { sourceCapturedAt });
    return summariseR1(snapshot, companyId, sourceRef);
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`R1 weekly=${result.weekly}; total=${result.total}; sourceCapturedAt=${result.sourceCapturedAt}; saved ${out}`);
} finally {
  await sql.end();
}
