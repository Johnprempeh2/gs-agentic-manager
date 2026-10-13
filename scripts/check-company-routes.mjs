#!/usr/bin/env node
// Every route mounted under /:companyPrefix in ui/src/App.tsx must be listed in
// BOARD_ROUTE_ROOTS (ui/src/lib/company-routes.ts). A missing root makes the app
// read it as a company prefix ("Organization not found"), and every sidebar link
// clicked after it breaks too (strategy-board, billing, intelligence all shipped
// this way). Dependency-free so the always-on CI guard job can run it.
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../ui/src/lib/company-routes.ts", import.meta.url), "utf8");

const setLiteral = (name) => {
  const m = routes.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`could not find ${name} in company-routes.ts`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
};
// Also mounted at the top level, so a bare /onboarding or /tests is not a company prefix
// (same exemption as company-routes.test.ts).
const GLOBAL_TOO = ["instance", "onboarding", "tests"];
const known = new Set([...setLiteral("BOARD_ROUTE_ROOTS"), ...setLiteral("GLOBAL_ROUTE_ROOTS"), ...GLOBAL_TOO]);

const start = app.indexOf("function boardRoutes");
if (start < 0) throw new Error("could not find boardRoutes() in App.tsx");
const body = app.slice(start, app.indexOf("\nfunction ", start + 1));
const roots = new Set([...body.matchAll(/path="([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
if (roots.size < 30) throw new Error(`only ${roots.size} roots found in boardRoutes(); the parser needs updating`);

const missing = [...roots].filter((r) => !known.has(r));
if (missing.length) {
  console.error(`Routes mounted in boardRoutes() but missing from BOARD_ROUTE_ROOTS: ${missing.join(", ")}`);
  console.error("Add them to ui/src/lib/company-routes.ts, or links to them break (\"Organization not found\").");
  process.exit(1);
}
console.log(`Company routes OK: ${roots.size} roots, all registered.`);
