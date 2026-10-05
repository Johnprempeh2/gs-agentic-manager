import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures");

function readJson(name) {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8"));
}

export function loadFixtures() {
  const world = readJson("kestrel-works.json");
  const { scenarios } = readJson("scenarios.json");
  const graph = readJson("graph.json");
  if (world.synthetic !== true) throw new Error("kestrel-works.json must be marked synthetic");
  if (graph.synthetic !== true) throw new Error("graph.json must be marked synthetic");
  return { world, scenarios, graph };
}

export function identity(world, id) {
  const found = world.identities.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown fixture identity: ${id}`);
  return found;
}

export function scope(world, id) {
  return world.scopes.find((s) => s.id === id) ?? null;
}

export function grantedScopes(world, identityId, right) {
  return identity(world, identityId)
    .grants.filter((g) => g.rights.includes(right))
    .map((g) => g.scope);
}

// D7 values are stored in parts so the committed file never holds a token-shaped string.
export function d7Items(scenarios) {
  return scenarios.D7.items.map((item) => ({ ...item, value: item.parts.join("") }));
}

export function record(scenarios, id) {
  for (const s of Object.values(scenarios)) {
    const r = s.records?.find((x) => x.id === id);
    if (r) return r;
  }
  throw new Error(`Unknown fixture record: ${id}`);
}
