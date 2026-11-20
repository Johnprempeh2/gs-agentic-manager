import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

// GRE-5821: cold opens of the task list and a long task against a realistic
// amount of data (500 tasks, one with 300 comments). Records the time until
// each screen shows its first useful content, and every API call the open made
// until the page settled, so duplicate, waterfall and oversized requests show.
const requestedRuns = Number(process.env.GSAM_ISSUE_PERF_RUNS ?? 5);
const RUNS = Number.isFinite(requestedRuns) ? Math.max(3, Math.floor(requestedRuns)) : 5;
const ISSUE_COUNT = Number(process.env.GSAM_ISSUE_PERF_LARGE_ISSUES ?? 500);
const COMMENT_COUNT = Number(process.env.GSAM_ISSUE_PERF_LARGE_COMMENTS ?? 300);
const TRACE = process.env.GSAM_ISSUE_PERF_TRACE === "1";
const SETTLE_MS = 2_500;
const READY_TIMEOUT_MS = 90_000;
const OUTPUT_DIR = path.resolve(process.cwd(), "test-results/issue-detail-perf/large-data");
const STATUSES = ["backlog", "todo", "in_review", "done"] as const;

type ApiCall = {
  method: string;
  initiator?: string;
  path: string;
  startMs: number;
  endMs: number | null;
  bytes: number;
  status?: number;
};

type Sample = {
  screen: "list" | "issue";
  run: number;
  readyMs: number;
  domNodes: number;
  apiCalls: ApiCall[];
};

type Seed = { prefix: string; issueId: string; identifier: string; newestTitle: string; newestCommentMarker: string };

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function commentBody(index: number): string {
  const paragraphs = [
    `Update ${index}: checked the run output and the follow-up items below.`,
    "- The worker picked up the change and wrote the result to the task.\n- Two checks still run; I will post the numbers when they finish.\n- No action needed from the reviewer yet.",
    "```sh\npnpm --filter @greatstone/server exec vitest run src/__tests__/example.test.ts\n```",
    `Notes: ${"the measured value stayed within the budget and the next step is clear. ".repeat(1 + (index % 6))}`,
  ];
  return paragraphs.slice(0, 2 + (index % 3)).join("\n\n");
}

async function seed(request: Page["request"]): Promise<Seed> {
  const companyResponse = await request.post("/api/companies", { data: { name: `Large Perf ${Date.now()}` } });
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json();
  for (const step of ["start", "practice/clear"]) {
    const response = await request.post(`/api/companies/${company.id}/onboarding/me/${step}`);
    expect(response.ok(), await response.text()).toBe(true);
  }

  const longIssueResponse = await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: `Long thread task ${Date.now()}`, description: "A task with a long comment thread.\n\n".repeat(6), status: "todo", priority: "high" },
  });
  expect(longIssueResponse.ok(), await longIssueResponse.text()).toBe(true);
  const longIssue = await longIssueResponse.json();
  let newestCommentMarker = "";
  for (let index = 1; index <= COMMENT_COUNT; index += 1) {
    const body = commentBody(index);
    const response = await request.post(`/api/issues/${longIssue.id}/comments`, { data: { body } });
    expect(response.ok(), await response.text()).toBe(true);
    newestCommentMarker = `Update ${index}:`;
  }

  let newestTitle = "";
  for (let index = 1; index < ISSUE_COUNT; index += 1) {
    const title = `Seeded list task ${index} ${Date.now()}`;
    const response = await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title,
        description: `Seeded task ${index} for the list measurement.\n\n${"Context line for the task. ".repeat(8)}`,
        status: STATUSES[index % STATUSES.length],
        priority: index % 3 === 0 ? "high" : "medium",
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    newestTitle = title;
  }

  return { prefix: company.issuePrefix ?? company.prefix, issueId: longIssue.id, identifier: longIssue.identifier, newestTitle, newestCommentMarker };
}

async function sample(baseURL: string, screen: Sample["screen"], seedData: Seed, run: number): Promise<Sample> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    if (TRACE) {
      await session.send("Debugger.enable");
      await session.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
    }
    const calls = new Map<string, ApiCall>();
    let origin: number | null = null;
    session.on("Network.requestWillBeSent", (event) => {
      origin ??= event.timestamp * 1000;
      const url = new URL(event.request.url);
      if (!url.pathname.startsWith("/api/")) return;
      const frames: string[] = [];
      for (let stack = event.initiator?.stack; stack && frames.length < 60; stack = stack.parent) {
        for (const frame of stack.callFrames) frames.push(`${frame.functionName || "?"}@${frame.url.split("/").pop()}:${frame.lineNumber}:${frame.columnNumber}`);
      }
      calls.set(event.requestId, {
        initiator: TRACE ? frames.slice(0, 60).join(" < ") : undefined,
        method: event.request.method,
        path: `${url.pathname}${url.search}`,
        startMs: event.timestamp * 1000 - origin,
        endMs: null,
        bytes: 0,
      });
    });
    session.on("Network.responseReceived", (event) => {
      const call = calls.get(event.requestId);
      if (call) call.status = event.response.status;
    });
    session.on("Network.loadingFinished", (event) => {
      const call = calls.get(event.requestId);
      if (!call || origin === null) return;
      call.endMs = event.timestamp * 1000 - origin;
      call.bytes = event.encodedDataLength;
    });

    const target = screen === "list" ? `/${seedData.prefix}/issues` : `/${seedData.prefix}/issues/${seedData.identifier}`;
    const marker = screen === "list" ? seedData.newestTitle : seedData.newestCommentMarker;
    await page.goto(target, { waitUntil: "commit" });
    const handle = await page.waitForFunction(
      (text) => (document.body?.innerText ?? "").includes(text) ? performance.now() : false,
      marker,
      { polling: "raf", timeout: READY_TIMEOUT_MS },
    );
    const readyMs = Number(await handle.jsonValue());
    await page.waitForTimeout(SETTLE_MS);
    const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
    if (run === 1) {
      await page.screenshot({ path: path.join(OUTPUT_DIR, `${screen}-1440.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUTPUT_DIR, `${screen}-390.png`) });
    }
    await context.close();
    return { screen, run, readyMs, domNodes, apiCalls: [...calls.values()] };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function summarize(samples: Sample[], screen: Sample["screen"]) {
  const runs = samples.filter((entry) => entry.screen === screen);
  const counts = runs.map((entry) => entry.apiCalls.length);
  const bytes = runs.map((entry) => entry.apiCalls.reduce((sum, call) => sum + call.bytes, 0));
  const duplicates = runs.map((entry) => {
    const seen = new Map<string, number>();
    for (const call of entry.apiCalls) seen.set(`${call.method} ${call.path}`, (seen.get(`${call.method} ${call.path}`) ?? 0) + 1);
    return [...seen.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  });
  const byPath = new Map<string, { calls: number; bytes: number; ms: number }>();
  for (const call of runs[0]?.apiCalls ?? []) {
    const key = `${call.method} ${call.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
    const entry = byPath.get(key) ?? { calls: 0, bytes: 0, ms: 0 };
    entry.calls += 1;
    entry.bytes += call.bytes;
    entry.ms = Math.max(entry.ms, call.endMs === null ? 0 : call.endMs - call.startMs);
    byPath.set(key, entry);
  }
  return {
    screen,
    runs: runs.length,
    readyMedianMs: Math.round(median(runs.map((entry) => entry.readyMs))),
    readyMinMs: Math.round(Math.min(...runs.map((entry) => entry.readyMs))),
    readyMaxMs: Math.round(Math.max(...runs.map((entry) => entry.readyMs))),
    apiCallsMedian: median(counts),
    apiBytesMedianKiB: Number((median(bytes) / 1024).toFixed(1)),
    duplicateCallsMedian: median(duplicates),
    domNodesMedian: median(runs.map((entry) => entry.domNodes)),
    firstRunCalls: [...byPath.entries()]
      .sort((left, right) => right[1].bytes - left[1].bytes)
      .map(([key, value]) => `${key} x${value.calls} ${(value.bytes / 1024).toFixed(1)} KiB ${Math.round(value.ms)} ms`),
  };
}

test("large-data task list and long task cold open", async ({ request, baseURL }) => {
  test.setTimeout(60 * 60_000);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const seedData = await seed(request);
  const samples: Sample[] = [];
  // One unmeasured warm-up per screen so the first sample does not pay server JIT and cache fills.
  await sample(baseURL!, "list", seedData, 0);
  await sample(baseURL!, "issue", seedData, 0);
  for (let run = 1; run <= RUNS; run += 1) {
    samples.push(await sample(baseURL!, "list", seedData, run));
    samples.push(await sample(baseURL!, "issue", seedData, run));
  }
  const summary = { issues: ISSUE_COUNT, comments: COMMENT_COUNT, list: summarize(samples, "list"), issue: summarize(samples, "issue") };
  await fs.writeFile(path.join(OUTPUT_DIR, "samples.json"), JSON.stringify({ seed: seedData, samples }, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
});
