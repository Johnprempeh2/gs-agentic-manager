// Run: node --test scripts/import-leaderboard-history.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { historyToSnapshots } from "./import-leaderboard-history.mjs";

test("maps the hub's three boards, uses the index as the Frontier Models score, and sorts by rank", () => {
  const snapshots = historyToSnapshots({
    snapshots: [
      {
        date: "2026-10-13",
        products: { Gemini: { rank: 2, score: 96.6 }, Claude: { rank: 1, score: 97.3 } },
        models: { Claude: { rank: 1, index: 58 }, Kimi: { rank: 2, index: null } },
        tools: {},
      },
      { date: "not a date", products: { X: { rank: 1, score: 1 } } },
    ],
  });
  assert.deepEqual(snapshots, [
    {
      board: "ai_systems",
      snapshotDate: "2026-10-13",
      entries: [
        { name: "Claude", rank: 1, score: 97.3 },
        { name: "Gemini", rank: 2, score: 96.6 },
      ],
    },
    {
      board: "frontier_models",
      snapshotDate: "2026-10-13",
      entries: [
        { name: "Claude", rank: 1, score: 58 },
        { name: "Kimi", rank: 2, score: null },
      ],
    },
  ]);
});
