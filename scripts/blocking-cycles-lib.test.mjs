import assert from "node:assert/strict";
import { test } from "node:test";
import { findBlockingCycles } from "./blocking-cycles-lib.mjs";

const edge = (id, blockerIssueId, blockedIssueId, companyId = "c1") => ({ id, companyId, blockerIssueId, blockedIssueId });

test("finds two tasks that block each other", () => {
  const cycles = findBlockingCycles([edge("r1", "a", "b"), edge("r2", "b", "a"), edge("r3", "b", "c")]);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].issueIds, ["a", "b"]);
  assert.deepEqual(cycles[0].edges.map((e) => e.id).sort(), ["r1", "r2"]);
});

test("finds a longer loop and ignores a plain chain", () => {
  const cycles = findBlockingCycles([
    edge("r1", "a", "b"),
    edge("r2", "b", "c"),
    edge("r3", "c", "a"),
    edge("r4", "x", "y"),
    edge("r5", "y", "z"),
  ]);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].issueIds, ["a", "b", "c"]);
});

test("keeps companies apart", () => {
  const cycles = findBlockingCycles([edge("r1", "a", "b", "c1"), edge("r2", "b", "a", "c2")]);
  assert.deepEqual(cycles, []);
});

test("handles a long chain without overflowing the stack", () => {
  const edges = [];
  for (let i = 0; i < 50_000; i += 1) edges.push(edge(`r${i}`, `t${i}`, `t${i + 1}`));
  edges.push(edge("back", "t50000", "t0"));
  const cycles = findBlockingCycles(edges);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].issueIds.length, 50_001);
});
