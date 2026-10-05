// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/ports.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { choosePorts, siblingPortClaims } from "./ports.js";

const instances = mkdtempSync(path.join(tmpdir(), "ports-test-"));
after(() => rmSync(instances, { recursive: true, force: true }));

// A stopped sibling: its state file claims 3300/55400, but nothing listens.
const sibling = path.join(instances, "c001");
mkdirSync(sibling);
writeFileSync(path.join(sibling, "client-instance.json"), JSON.stringify({ edition: "managed", port: 3300, dbPort: 55400 }));
mkdirSync(path.join(instances, "releases"));
const newRoot = path.join(instances, "c002");

// Every port is free on the host, as with a stopped sibling.
const allFree = async (from: number, to: number, skip: Set<number>) => {
  for (let port = from; port <= to; port += 1) if (!skip.has(port)) return port;
  throw new Error("none free");
};

test("create skips the ports that a stopped sibling claims", async () => {
  const claims = siblingPortClaims(newRoot);
  assert.deepEqual(claims, [{ root: sibling, port: 3300, dbPort: 55400 }]);
  assert.deepEqual(await choosePorts({ claims, firstFree: allFree }), { port: 3301, dbPort: 55401 });
});

test("an explicit port that a sibling claims is refused, naming the sibling", async () => {
  const claims = siblingPortClaims(newRoot);
  await assert.rejects(choosePorts({ port: 3300, claims, firstFree: allFree }), (err: Error) => {
    assert.match(err.message, /--port 3300 is claimed by the instance at .*c001/);
    return true;
  });
  await assert.rejects(choosePorts({ dbPort: 55400, claims, firstFree: allFree }), /--db-port 55400 .*c001/);
  assert.deepEqual(await choosePorts({ port: 3310, dbPort: 55410, claims, firstFree: allFree }), { port: 3310, dbPort: 55410 });
});

test("the new root itself and folders without a state file claim nothing", () => {
  assert.deepEqual(siblingPortClaims(sibling), []);
  assert.deepEqual(siblingPortClaims(path.join(instances, "missing", "c001")), []);
});
