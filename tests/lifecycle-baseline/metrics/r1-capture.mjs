// John-operated live R1 capture. Run only after source-specific approval
// recorded on GRE-3269; see r1-capture.md. Never run inside an agent heartbeat.
import { createRequire } from "node:module";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureR1Snapshot, summariseR1 } from "./r1-snapshot.mjs";
import { readSourceContract, verifyReadOnlySource } from "./r1-source-contract.mjs";

const args = process.argv.slice(2);
if (process.env.GSAM_API_KEY || process.env.GSAM_RUN_ID) throw new Error("R1 operator capture must not run inside an agent run");
const allowed = new Set(["--company", "--source-ref", "--contract", "--out"]);
for (let index = 0; index < args.length; index += 2) {
  if (!allowed.has(args[index]) || !args[index + 1]) throw new Error(`Unknown or incomplete R1 argument: ${args[index]}`);
}
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}`);
  return args[index + 1];
};
const databaseUrl = process.env.R1_SOURCE_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing R1_SOURCE_DATABASE_URL in operator environment");
const companyId = value("--company");
const sourceRef = value("--source-ref");
const out = resolve(value("--out"));
const contractPath = resolve(value("--contract"));
if ((statSync(contractPath).mode & 0o077) !== 0) throw new Error("R1 contract file must be private (mode 0600)");
const contract = readSourceContract(contractPath, { companyId, sourceRef, databaseUrl, out });
const parsed = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
  throw new Error("R1 capture accepts only a loopback database");
}
if (!out.endsWith(".json")) throw new Error("--out must name a JSON file");

const root = resolve(import.meta.dirname, "../../..");
const postgres = createRequire(resolve(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const snapshot = await captureR1Snapshot(tx, companyId, { verifySource: (reader) => verifyReadOnlySource(reader, contract) });
    return summariseR1(snapshot, companyId, sourceRef);
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`R1 weekly=${result.weekly}; total=${result.total}; sourceCapturedAt=${result.sourceCapturedAt}; saved ${out}`);
} finally {
  await sql.end();
}
