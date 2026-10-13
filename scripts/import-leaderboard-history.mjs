#!/usr/bin/env node
// One-off import of the AI Intelligence Hub's leaderboard history into GSAM,
// so the Intelligence page keeps the hub's history and movement.
//
// Usage:
//   GSAM_API_URL=http://localhost:3100 GSAM_COMPANY_ID=<company id> [GSAM_API_KEY=<board or agent key>] \
//     node scripts/import-leaderboard-history.mjs <path to history.json> [--dry-run]
//
// history.json is the generator's file ("Skill Dev/ai-leaderboard/history.json"):
// { snapshots: [{ date, products: { name: { rank, score } }, models: { name: { rank, index } }, tools: { name: { rank, score } } }] }
// Each snapshot becomes up to three board snapshots (PUT, so a rerun replaces, never duplicates).
// An agent key needs the intelligence:write permission; the Intelligence switch must be on.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BOARDS = [
  ["products", "ai_systems", "score"],
  ["models", "frontier_models", "index"],
  ["tools", "tools_agents", "score"],
];

/** history.json to [{ board, snapshotDate, entries }], entries in rank order. */
export function historyToSnapshots(history) {
  const out = [];
  for (const snap of history?.snapshots ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snap?.date ?? "")) continue;
    for (const [key, board, field] of BOARDS) {
      const entries = Object.entries(snap[key] ?? {})
        .filter(([, row]) => Number.isInteger(row?.rank) && row.rank >= 1)
        .map(([name, row]) => ({ name, rank: row.rank, score: typeof row[field] === "number" ? row[field] : null }))
        .sort((a, b) => a.rank - b.rank);
      if (entries.length > 0) out.push({ board, snapshotDate: snap.date, entries });
    }
  }
  return out;
}

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const apiUrl = process.env.GSAM_API_URL?.replace(/\/$/, "");
  const companyId = process.env.GSAM_COMPANY_ID;
  if (!file || (!dryRun && (!apiUrl || !companyId))) {
    console.error("Usage: GSAM_API_URL=... GSAM_COMPANY_ID=... node scripts/import-leaderboard-history.mjs <history.json> [--dry-run]");
    process.exit(2);
  }
  const snapshots = historyToSnapshots(JSON.parse(readFileSync(file, "utf8")));
  console.log(`${snapshots.length} board snapshots from ${file}`);
  if (dryRun) {
    for (const s of snapshots) console.log(`${s.snapshotDate} ${s.board}: ${s.entries.length} entries`);
    return;
  }
  const headers = { "content-type": "application/json" };
  if (process.env.GSAM_API_KEY) headers.authorization = `Bearer ${process.env.GSAM_API_KEY}`;
  let failed = 0;
  for (const s of snapshots) {
    const url = `${apiUrl}/api/companies/${encodeURIComponent(companyId)}/intelligence/boards/${s.board}/snapshots/${s.snapshotDate}`;
    const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ entries: s.entries }) });
    if (!response.ok) {
      failed += 1;
      console.error(`${s.snapshotDate} ${s.board}: ${response.status} ${await response.text()}`);
    }
  }
  console.log(`Imported ${snapshots.length - failed}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
