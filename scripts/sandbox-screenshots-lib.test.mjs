import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROUTES,
  buildContactSheetHtml,
  buildIndexMarkdown,
  parseArgs,
  resolveRoute,
  routeSlug,
  shotFileName,
} from "./sandbox-screenshots-lib.mjs";

test("defaults: both themes, both viewports, seeded sandbox", () => {
  const options = parseArgs([]);
  assert.deepEqual(options.themes, ["light", "dark"]);
  assert.deepEqual(options.viewports, ["desktop", "phone"]);
  assert.equal(options.routes, null);
  assert.equal(options.seed, true);
  assert.equal(options.scale, 1);
});

test("--routes, --dark, --viewports and --attach", () => {
  const options = parseArgs(["--routes", "dashboard, issues/{issue},", "--dark", "--viewports=phone", "--attach", "abc"]);
  assert.deepEqual(options.routes, ["dashboard", "issues/{issue}"]);
  assert.deepEqual(options.themes, ["dark"]);
  assert.deepEqual(options.viewports, ["phone"]);
  assert.equal(options.attach, "abc");
});

test("--light --dark keeps both in a fixed order", () => {
  assert.deepEqual(parseArgs(["--dark", "--light"]).themes, ["light", "dark"]);
});

test("--routes-file reads through the injected reader", () => {
  const options = parseArgs(["--routes-file", "r.json"], { readFile: (file) => (file === "r.json" ? ["agents/all"] : []) });
  assert.deepEqual(options.routes, ["agents/all"]);
});

test("--base-url does not seed unless asked and rejects sandbox-only flags", () => {
  assert.equal(parseArgs(["--base-url", "http://127.0.0.1:3300/"]).seed, false);
  assert.equal(parseArgs(["--base-url", "http://127.0.0.1:3300/"]).baseUrl, "http://127.0.0.1:3300");
  assert.equal(parseArgs(["--base-url", "http://127.0.0.1:3300", "--seed"]).seed, true);
  assert.throws(() => parseArgs(["--base-url", "http://x", "--port", "3300"]), /--base-url/);
});

test("bad input fails clearly", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--routes"]), /requires a value/);
  assert.throws(() => parseArgs(["--viewports", "tablet"]), /unknown viewport/);
  assert.throws(() => parseArgs(["--port", "80"]), /--port/);
  assert.throws(() => parseArgs(["--routes", ","]), /no routes/);
});

test("company relative routes get the prefix", () => {
  const seed = { companyPrefix: "nwr", ids: { issue: "NWR-1", agent: "a1" } };
  assert.equal(resolveRoute("dashboard", seed).path, "/NWR/dashboard");
  assert.equal(resolveRoute("/issues/{issue}", seed).path, "/NWR/issues/NWR-1");
  assert.equal(resolveRoute("agents/{agent}?tab=runs", seed).path, "/NWR/agents/a1?tab=runs");
});

test("global roots and already prefixed routes are left alone", () => {
  const seed = { companyPrefix: "NWR", ids: {} };
  assert.equal(resolveRoute("instance/settings/general", seed).path, "/instance/settings/general");
  assert.equal(resolveRoute("/NWR/projects", seed).path, "/NWR/projects");
  assert.equal(resolveRoute("/nwr/projects", seed).path, "/nwr/projects");
});

test("an unfilled placeholder is reported, not guessed", () => {
  const result = resolveRoute("projects/{project}", { companyPrefix: "NWR", ids: {} });
  assert.equal(result.path, null);
  assert.match(result.error, /\{project\}/);
});

test("default routes all resolve with a full seed", () => {
  const seed = { companyPrefix: "NWR", ids: { issue: "NWR-1", agent: "a1", project: "p1" } };
  for (const route of DEFAULT_ROUTES) assert.ok(resolveRoute(route, seed).path, route);
});

test("file names are stable and safe", () => {
  assert.equal(routeSlug("issues/{issue}"), "issues-issue");
  assert.equal(routeSlug("/"), "root");
  assert.equal(shotFileName("company/settings", "phone", "dark"), "company-settings--phone--dark.png");
});

test("index and contact sheet list every shot and escape HTML", () => {
  const meta = {
    title: "Shots",
    baseUrl: "http://127.0.0.1:3300",
    generatedAt: "2026-10-16T00:00:00Z",
    shots: [
      { route: "dashboard", path: "/NWR/dashboard", viewport: "desktop", theme: "light", file: "dashboard--desktop--light.png", consoleErrors: 0, error: null },
      { route: "<x>", path: "/NWR/x", viewport: "phone", theme: "dark", file: "x--phone--dark.png", consoleErrors: 2, error: "timeout" },
    ],
    skipped: [{ route: "projects/{project}", error: "no seeded value for {project}" }],
  };
  const md = buildIndexMarkdown(meta);
  assert.match(md, /dashboard--desktop--light\.png/);
  assert.match(md, /failed: timeout/);
  assert.match(md, /projects\/\{project\}: no seeded value/);
  const html = buildContactSheetHtml(meta);
  assert.match(html, /<img src="dashboard--desktop--light\.png"/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /<x>/);
});
