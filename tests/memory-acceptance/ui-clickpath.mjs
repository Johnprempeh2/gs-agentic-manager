#!/usr/bin/env node
// Plan GRE-646 8.3.3 on the screens (GRE-866): contribution -> graph -> source, back, and
// source -> memory, node -> contributor's activity. Runs against a sandbox server in
// local_trusted mode that already holds a synthetic Kestrel Works company (for example the one
// `run.mjs --target gsam --phase 3` provisions). It adds one synthetic task and one memory
// linked to it as the board, then drives the UI in a headless browser.
//
//   MEMORY_UI_BASE=http://127.0.0.1:<sandbox port> node tests/memory-acceptance/ui-clickpath.mjs [--shots <dir>]
//
// Refuses port 3100 (the live app). Exit 0 only if every step passes.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = (process.env.MEMORY_UI_BASE ?? "").replace(/\/$/, "");
if (!base) throw new Error("Set MEMORY_UI_BASE to the sandbox server URL");
if (new URL(base).port === "3100") throw new Error("Refusing port 3100: that is the live app");
const shotsArg = process.argv.indexOf("--shots");
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

async function api(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// The newest synthetic Kestrel Works company, its client scope, then one task and one memory.
const company = (await api("/companies"))
  .filter((c) => c.name.startsWith("Kestrel Works (synthetic"))
  .sort((a, b) => b.name.localeCompare(a.name))[0];
if (!company) throw new Error("No synthetic Kestrel Works company: run the phase 3 gsam target first");
const scope = (await api(`/companies/${company.id}/memory/scopes`)).find((s) => s.name === "Alder Bakery");
const stamp = new Date().toISOString();
const issue = await api(`/companies/${company.id}/issues`, {
  method: "POST",
  body: { title: `Alder supplier lead time check (synthetic ${stamp})`, status: "todo" },
});
const recordTitle = `Alder flour supplier lead time (synthetic ${stamp})`;
const created = await api(`/companies/${company.id}/memory/records`, {
  method: "POST",
  body: {
    scopeId: scope.id,
    title: recordTitle,
    content: "Synthetic: the Alder flour supplier needs five working days notice.",
    entryType: "observation",
    topics: ["supplier"],
    entities: ["Alder Bakery"],
    sourceKind: "issue",
    sourceId: issue.id,
  },
});
const recordId = (created.record ?? created).id;
const P = company.issuePrefix;

const results = [];
const step = (name, detail = "") => {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const shot = async (name) => {
  if (!shots) return;
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/${name}.png` });
};
const path = () => page.url().replace(base, "");
const sourceLink = () => page.getByRole("link", { name: /^Task / }).first();
let failed = false;
try {
  await page.goto(`${base}/${P}/memory/activity`, { waitUntil: "networkidle" });
  const item = page.locator("li", { hasText: recordTitle }).first();
  await item.waitFor({ timeout: 20000 });
  step("activity feed lists the contribution");
  await shot("1-activity");

  await item.getByRole("link", { name: "Show in graph" }).click();
  await page.waitForURL((u) => u.pathname.endsWith("/memory") && u.searchParams.get("node") === recordId, { timeout: 15000 });
  await sourceLink().waitFor({ timeout: 15000 });
  step("Show in graph opens the graph with the node and its source", path());
  await shot("2-graph-node");

  await sourceLink().click();
  await page.waitForURL((u) => u.pathname.includes(`/issues/${issue.id}`), { timeout: 15000 });
  await page.getByText(issue.title).first().waitFor({ timeout: 15000 });
  step("source link opens the source task", path());
  await shot("3-source-task");

  await page.goBack();
  await page.waitForURL((u) => u.searchParams.get("node") === recordId, { timeout: 15000 });
  await sourceLink().waitFor({ timeout: 15000 });
  step("Back returns to the same graph node", path());

  await page.getByRole("link", { name: "See this contributor's activity" }).click();
  await page.waitForURL((u) => u.pathname.endsWith("/memory/activity"), { timeout: 15000 });
  await page.locator("li", { hasText: recordTitle }).first().waitFor({ timeout: 15000 });
  step("node -> contributor's activity shows the contribution", path());

  await page.goto(`${base}/${P}/memory`, { waitUntil: "networkidle" });
  await page.getByPlaceholder(/search memory/i).fill(issue.id);
  await page.getByRole("region", { name: "Memory list" }).getByText(recordTitle).first().waitFor({ timeout: 15000 });
  step("searching the source task id finds its memory", path());
  await shot("4-source-search");
} catch (err) {
  failed = true;
  console.log(`FAIL  ${String(err.message).split("\n")[0]}`);
  await shot("fail").catch(() => {});
} finally {
  await browser.close();
}
console.log(`\n${results.length} steps passed${failed ? ", 1 failed" : ""}`);
process.exit(failed ? 1 : 0);
