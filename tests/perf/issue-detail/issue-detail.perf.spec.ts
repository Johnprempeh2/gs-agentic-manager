import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const requestedRuns = Number(process.env.GSAM_ISSUE_PERF_RUNS ?? 5);
const RUNS = Number.isFinite(requestedRuns) ? Math.max(5, Math.floor(requestedRuns)) : 5;
const OUTPUT_DIR = path.resolve(process.cwd(), "test-results/issue-detail-perf");
const PAGE_READY_TIMEOUT_MS = 90_000;
const HEADER_MEASURE = "issue-detail:navigate→header-paint";
const CONTENT_MEASURE = "issue-detail:navigate→content-paint";
const HEADER_MARK = "issue-detail:header-paint";
const CONTENT_MARK = "issue-detail:content-paint";

type Profile = {
  name: "unthrottled" | "fast-4g-4x-cpu";
  latencyMs?: number;
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
  cpuSlowdownRate?: number;
};

type NetworkRecord = {
  requestId: string;
  url: string;
  method: string;
  type: string;
  encodedDataLength: number;
  mimeType?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  ttfbMs?: number;
  completedAtEpochMs?: number;
};

type RunMetrics = {
  scenario: "S1 warm in-app navigation" | "S2 cold open";
  profile: Profile["name"];
  run: number;
  headerPaintMs: number;
  contentPaintMs: number;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  requestCountBeforeContentPaint: number;
  apiRequestCountBeforeContentPaint: number;
  bytesBeforeContentPaint: number;
  jsBytesBeforeContentPaint: number;
  issueApiTtfbMs: number | null;
  issueApiServerTiming: string | null;
};

type Seed = {
  companyId: string;
  prefix: string;
  issueId: string;
  identifier: string;
  title: string;
  boardIssueCount: number;
  boardMarkerTitles: string[];
};

type BoardMetrics = {
  scenario: "S3 board cold open";
  profile: Profile["name"];
  run: number;
  boardReadyMs: number;
};

// Ten per column equals the default column page size, so every seeded card renders.
const BOARD_ISSUES_PER_STATUS = 10;
const BOARD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

const ALL_PROFILES: Profile[] = [
  { name: "unthrottled" },
  {
    name: "fast-4g-4x-cpu",
    latencyMs: 50,
    downloadBytesPerSecond: Math.floor(9 * 1024 * 1024 / 8),
    uploadBytesPerSecond: Math.floor(1.5 * 1024 * 1024 / 8),
    cpuSlowdownRate: 4,
  },
];
// GSAM_ISSUE_PERF_PROFILES=unthrottled limits a run to named profiles (CI gates unthrottled only).
const requestedProfiles = process.env.GSAM_ISSUE_PERF_PROFILES?.split(",").map((name) => name.trim()).filter(Boolean);
const PROFILES = requestedProfiles?.length
  ? ALL_PROFILES.filter((profile) => requestedProfiles.includes(profile.name))
  : ALL_PROFILES;
if (requestedProfiles?.length && PROFILES.length !== requestedProfiles.length) {
  throw new Error(`Unknown GSAM_ISSUE_PERF_PROFILES entry; expected any of ${ALL_PROFILES.map((profile) => profile.name).join(", ")}`);
}
// Each run is three fresh-browser samples (about 1 s each unthrottled, far longer throttled); leave room for seeding.
const TEST_TIMEOUT_MS = 10 * 60_000 + RUNS * PROFILES.length * 3 * 60_000;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// Nearest-rank percentile; with the default five samples p95 is the slowest sample.
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  return `${(value / 1024).toFixed(1)} KiB`;
}

async function seed(request: Page["request"]): Promise<Seed> {
  const companyResponse = await request.post("/api/companies", {
    data: { name: `Issue Perf ${Date.now()}` },
  });
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json();

  const title = `Issue detail performance baseline ${Date.now()}`;
  const issueResponse = await request.post(`/api/companies/${company.id}/issues`, {
    data: {
      title,
      description: "A seeded issue description used to measure the first meaningful issue-detail content paint.\n\n".repeat(12),
      priority: "high",
      status: "todo",
    },
  });
  expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
  const issue = await issueResponse.json();

  for (let index = 1; index <= 12; index += 1) {
    const commentResponse = await request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: `Seeded performance comment ${index}: ${"content ".repeat(24)}` },
    });
    expect(commentResponse.ok(), await commentResponse.text()).toBe(true);
  }

  // A populated board: every open column carries cards. One card per column is
  // the readiness marker, so the board counts as loaded once all columns render.
  const boardMarkerTitles: string[] = [];
  for (const status of BOARD_STATUSES) {
    for (let index = 1; index <= BOARD_ISSUES_PER_STATUS; index += 1) {
      const boardTitle = `Board ${status} card ${index} ${Date.now()}`;
      const response = await request.post(`/api/companies/${company.id}/issues`, {
        // in_progress needs an assignee; the local-trusted board user avoids waking any agent.
        data: { title: boardTitle, description: `Seeded board card for ${status}.`, priority: "medium", status, ...(status === "in_progress" ? { assigneeUserId: "local-board" } : {}) },
      });
      expect(response.ok(), await response.text()).toBe(true);
      if (index === BOARD_ISSUES_PER_STATUS) boardMarkerTitles.push(boardTitle);
    }
  }

  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix,
    issueId: issue.id,
    identifier: issue.identifier,
    title,
    boardIssueCount: BOARD_STATUSES.length * BOARD_ISSUES_PER_STATUS + 1,
    boardMarkerTitles,
  };
}

async function configureProfile(context: BrowserContext, page: Page, profile: Profile) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  if (profile.latencyMs !== undefined) {
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadBytesPerSecond,
      uploadThroughput: profile.uploadBytesPerSecond,
      connectionType: "cellular4g",
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdownRate });
  }
  return session;
}

async function installVitalObserver(page: Page, cold: boolean): Promise<void> {
  await page.addInitScript(({ coldStart }) => {
    if (coldStart) window.__GSAM_ISSUE_DETAIL_NAVIGATE_START__ = 0;
    (window as Window & { __issuePerfLcp?: number }).__issuePerfLcp = undefined;
    try {
      new PerformanceObserver((list) => {
        const latest = list.getEntries().at(-1);
        if (latest) (window as Window & { __issuePerfLcp?: number }).__issuePerfLcp = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
  }, { coldStart: cold });
}

async function startNetworkCapture(session: Awaited<ReturnType<typeof configureProfile>>) {
  const records = new Map<string, NetworkRecord>();
  let cdpEpochOffsetMs: number | null = null;
  session.on("Network.requestWillBeSent", (event) => {
    cdpEpochOffsetMs ??= event.wallTime * 1000 - event.timestamp * 1000;
    records.set(event.requestId, {
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      type: event.type ?? "Other",
      encodedDataLength: 0,
    });
  });
  session.on("Network.responseReceived", (event) => {
    const record = records.get(event.requestId);
    if (!record) return;
    record.mimeType = event.response.mimeType;
    record.status = event.response.status;
    record.responseHeaders = Object.fromEntries(
      Object.entries(event.response.headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    if (event.response.timing) {
      record.ttfbMs = event.response.timing.receiveHeadersEnd - event.response.timing.sendStart;
    }
  });
  session.on("Network.loadingFinished", (event) => {
    const record = records.get(event.requestId);
    if (!record) return;
    record.encodedDataLength = event.encodedDataLength;
    if (cdpEpochOffsetMs !== null) record.completedAtEpochMs = cdpEpochOffsetMs + event.timestamp * 1000;
  });
  return records;
}

async function writeTrace(tracePath: string, metrics: RunMetrics, records: Map<string, NetworkRecord>) {
  await fs.mkdir(path.dirname(tracePath), { recursive: true });
  const traceEvents = [
    { name: "issue-detail:navigate", cat: "blink.user_timing", ph: "i", ts: 0, pid: 1, tid: 1, s: "t" },
    { name: HEADER_MEASURE, cat: "blink.user_timing", ph: "X", ts: 0, dur: metrics.headerPaintMs * 1000, pid: 1, tid: 1 },
    { name: CONTENT_MEASURE, cat: "blink.user_timing", ph: "X", ts: 0, dur: metrics.contentPaintMs * 1000, pid: 1, tid: 1 },
    ...[...records.values()].map((record, index) => ({
      name: record.url,
      cat: "loading",
      ph: "i",
      ts: index + 1,
      pid: 1,
      tid: 2,
      s: "t",
      args: { method: record.method, type: record.type, bytes: record.encodedDataLength, status: record.status },
    })),
  ];
  await fs.writeFile(tracePath, JSON.stringify({ traceEvents }));
}

// Cold opens are timed from browser navigation start (the paint marks' startTime), not from the
// page's own start mark: that mark is reset by any re-run of its effect (e.g. StrictMode in dev),
// which would silently drop bundle load from the number.
async function readPaintMetrics(page: Page, cold: boolean) {
  await page.waitForFunction((measureName) => performance.getEntriesByName(measureName).length > 0, CONTENT_MEASURE);
  await page.waitForTimeout(150);
  return page.evaluate(({ headerMeasure, contentMeasure, headerMark, contentMark, cold }) => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const sinceNavigation = (mark: string) => performance.getEntriesByName(mark, "mark")[0]?.startTime ?? NaN;
    return {
      headerPaintMs: cold ? sinceNavigation(headerMark) : performance.getEntriesByName(headerMeasure)[0]?.duration ?? NaN,
      contentPaintMs: cold ? sinceNavigation(contentMark) : performance.getEntriesByName(contentMeasure)[0]?.duration ?? NaN,
      ttfbMs: navigation ? navigation.responseStart - navigation.requestStart : null,
      fcpMs: fcp?.startTime ?? null,
      lcpMs: (window as Window & { __issuePerfLcp?: number }).__issuePerfLcp ?? null,
      contentPaintEpochMs: performance.timeOrigin + (performance.getEntriesByName(contentMeasure)[0]?.startTime ?? 0) + (performance.getEntriesByName(contentMeasure)[0]?.duration ?? 0),
    };
  }, { headerMeasure: HEADER_MEASURE, contentMeasure: CONTENT_MEASURE, headerMark: HEADER_MARK, contentMark: CONTENT_MARK, cold });
}

function summarizeNetwork(records: Map<string, NetworkRecord>, seedData: Seed, contentPaintEpochMs: number) {
  const completed = [...records.values()].filter((record) =>
    record.encodedDataLength > 0
    && record.completedAtEpochMs !== undefined
    && record.completedAtEpochMs <= contentPaintEpochMs
  );
  const api = completed.filter((record) => new URL(record.url).pathname.startsWith("/api/"));
  const scripts = completed.filter((record) => record.type === "Script" || record.mimeType?.includes("javascript"));
  const issueApi = completed.find((record) => {
    const pathname = new URL(record.url).pathname;
    return record.method === "GET" && (pathname === `/api/issues/${seedData.issueId}` || pathname === `/api/issues/${seedData.identifier}`);
  });
  return {
    requestCountBeforeContentPaint: completed.length,
    apiRequestCountBeforeContentPaint: api.length,
    bytesBeforeContentPaint: completed.reduce((sum, record) => sum + record.encodedDataLength, 0),
    jsBytesBeforeContentPaint: scripts.reduce((sum, record) => sum + record.encodedDataLength, 0),
    issueApiTtfbMs: issueApi?.ttfbMs ?? null,
    issueApiServerTiming: issueApi?.responseHeaders?.["server-timing"] ?? null,
  };
}

async function runScenario(browser: Browser, baseURL: string, seedData: Seed, profile: Profile, scenario: RunMetrics["scenario"], run: number): Promise<RunMetrics> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await installVitalObserver(page, scenario.startsWith("S2"));
  const session = await configureProfile(context, page, profile);
  const network = await startNetworkCapture(session);
  const tracePath = path.join(OUTPUT_DIR, `${scenario.slice(0, 2).toLowerCase()}-${profile.name}-run-${run}.trace.json`);

  if (scenario.startsWith("S1")) {
    await page.goto(`/${seedData.prefix}/issues`);
    const issueLink = page.locator("[data-inbox-issue-link]", { hasText: seedData.title }).first();
    await expect(issueLink).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
    network.clear();
    await page.evaluate(() => {
      window.__GSAM_ISSUE_DETAIL_NAVIGATE_START__ = performance.now();
    });
    await issueLink.click();
  } else {
    await page.goto(`/${seedData.prefix}/issues/${seedData.identifier}`);
  }

  // The loading shell and the thread both render a header briefly; timing comes from user-timing marks.
  await expect(page.getByTestId("issue-detail-header").first()).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  const paint = await readPaintMetrics(page, scenario.startsWith("S2"));
  const summary = summarizeNetwork(network, seedData, paint.contentPaintEpochMs);
  const { contentPaintEpochMs: _contentPaintEpochMs, ...reportedPaint } = paint;
  const scenarioPaint = scenario.startsWith("S1")
    ? { ...reportedPaint, ttfbMs: null, fcpMs: null, lcpMs: null }
    : reportedPaint;
  const metrics = { scenario, profile: profile.name, run, ...scenarioPaint, ...summary };
  if (run === 1) await writeTrace(tracePath, metrics, network);
  if (scenario.startsWith("S2") && profile.name === "unthrottled" && run === 1) {
    await page.screenshot({ path: path.join(OUTPUT_DIR, "issue-detail-loaded.png"), fullPage: true });
  }
  await context.close();

  expect(Number.isFinite(paint.headerPaintMs)).toBe(true);
  expect(Number.isFinite(paint.contentPaintMs)).toBe(true);
  return metrics;
}

async function runScenarioWithBrowserRetry(baseURL: string, seedData: Seed, profile: Profile, scenario: RunMetrics["scenario"], run: number): Promise<RunMetrics> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sampleBrowser = await chromium.launch();
    try {
      return await runScenario(sampleBrowser, baseURL, seedData, profile, scenario, run);
    } catch (error) {
      const browserClosed = error instanceof Error
        && (/Target page, context or browser has been closed/.test(error.message) || /Channel closed/.test(error.message));
      if (!browserClosed || attempt === 2) throw error;
    } finally {
      await sampleBrowser.close().catch(() => undefined);
    }
  }
  throw new Error("Unreachable browser retry state");
}

async function prepareBoardStorageState(browser: Browser, baseURL: string, seedData: Seed): Promise<string> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/${seedData.prefix}/issues`);
  await page.getByRole("button", { name: "Board view" }).click();
  await expect(page.getByText(seedData.boardMarkerTitles[0]).first()).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  const statePath = path.join(OUTPUT_DIR, "board-storage-state.json");
  await context.storageState({ path: statePath });
  await context.close();
  return statePath;
}

// Cold open of the issues board: navigation start until every open column shows its newest card.
async function runBoardSample(browser: Browser, baseURL: string, storageState: string, seedData: Seed, profile: Profile, run: number): Promise<BoardMetrics> {
  const context = await browser.newContext({ baseURL, storageState });
  const page = await context.newPage();
  await configureProfile(context, page, profile);
  await page.goto(`/${seedData.prefix}/issues`, { waitUntil: "commit" });
  const handle = await page.waitForFunction((titles) => {
    const text = document.body?.innerText ?? "";
    return titles.every((title) => text.includes(title)) ? performance.now() : false;
  }, seedData.boardMarkerTitles, { polling: "raf", timeout: PAGE_READY_TIMEOUT_MS });
  const boardReadyMs = Number(await handle.jsonValue());
  await context.close();
  expect(Number.isFinite(boardReadyMs)).toBe(true);
  return { scenario: "S3 board cold open", profile: profile.name, run, boardReadyMs };
}

function buildMetricsSummary(results: RunMetrics[], boardResults: BoardMetrics[]) {
  const stats = (values: number[]) => ({ n: values.length, medianMs: Math.round(median(values)), p95Ms: Math.round(percentile(values, 95)), maxMs: Math.round(Math.max(...values)) });
  return Object.fromEntries(PROFILES.map((profile) => [profile.name, {
    issueDetailWarmContentPaint: stats(results.filter((r) => r.profile === profile.name && r.scenario === "S1 warm in-app navigation").map((r) => r.contentPaintMs)),
    issueDetailColdContentPaint: stats(results.filter((r) => r.profile === profile.name && r.scenario === "S2 cold open").map((r) => r.contentPaintMs)),
    boardColdReady: stats(boardResults.filter((r) => r.profile === profile.name).map((r) => r.boardReadyMs)),
  }]));
}

function buildMarkdown(results: RunMetrics[], boardResults: BoardMetrics[] = []): string {
  const rows = PROFILES.flatMap((profile) => ["S1 warm in-app navigation", "S2 cold open"].map((scenario) => {
    const samples = results.filter((result) => result.profile === profile.name && result.scenario === scenario);
    const nullableMedian = (values: Array<number | null>) => {
      const present = values.filter((value): value is number => value !== null);
      return present.length > 0 ? median(present) : null;
    };
    const serverTimingMs = nullableMedian(samples.map((sample) => {
      const match = sample.issueApiServerTiming?.match(/dur=([0-9.]+)/);
      return match ? Number(match[1]) : null;
    }));
    return `| ${scenario} | ${profile.name} | ${samples.length} | ${formatMs(median(samples.map((sample) => sample.headerPaintMs)))} | ${formatMs(median(samples.map((sample) => sample.contentPaintMs)))} | ${formatMs(nullableMedian(samples.map((sample) => sample.ttfbMs)))} | ${formatMs(nullableMedian(samples.map((sample) => sample.fcpMs)))} | ${formatMs(nullableMedian(samples.map((sample) => sample.lcpMs)))} | ${Math.round(median(samples.map((sample) => sample.requestCountBeforeContentPaint)))} | ${Math.round(median(samples.map((sample) => sample.apiRequestCountBeforeContentPaint)))} | ${formatBytes(median(samples.map((sample) => sample.bytesBeforeContentPaint)))} | ${formatBytes(median(samples.map((sample) => sample.jsBytesBeforeContentPaint)))} | ${formatMs(nullableMedian(samples.map((sample) => sample.issueApiTtfbMs)))} | ${formatMs(serverTimingMs)} |`;
  }));
  return [
    "# Issue-detail performance baseline",
    "",
    `Runs per scenario/profile: ${RUNS}`,
    "",
    "| Scenario | Profile | N | Header paint | Content paint | TTFB | FCP | LCP | Requests before content | API requests before content | Bytes before content | JS bytes before content | GET issue TTFB | GET issue server timing |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Tracked number S2 (p95)",
    "",
    "| Profile | Measure | N | Median | p95 | Max |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(buildMetricsSummary(results, boardResults)).flatMap(([profile, measures]) =>
      Object.entries(measures).map(([measure, value]) => `| ${profile} | ${measure} | ${value.n} | ${formatMs(value.medianMs)} | ${formatMs(value.p95Ms)} | ${formatMs(value.maxMs)} |`)),
    "",
    "Raw samples and Chrome traces are in the same output directory.",
  ].join("\n");
}

test("issue-detail baseline", async ({ request, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  expect(baseURL).toBeTruthy();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const seedData = await seed(request);
  const results: RunMetrics[] = [];
  const boardResults: BoardMetrics[] = [];
  const setupBrowser = await chromium.launch();
  const boardState = await prepareBoardStorageState(setupBrowser, baseURL!, seedData).finally(() => setupBrowser.close());

  for (const profile of PROFILES) {
    for (let run = 1; run <= RUNS; run += 1) {
      results.push(await runScenarioWithBrowserRetry(baseURL!, seedData, profile, "S1 warm in-app navigation", run));
      results.push(await runScenarioWithBrowserRetry(baseURL!, seedData, profile, "S2 cold open", run));
      const boardBrowser = await chromium.launch();
      try {
        boardResults.push(await runBoardSample(boardBrowser, baseURL!, boardState, seedData, profile, run));
      } finally {
        await boardBrowser.close().catch(() => undefined);
      }
    }
  }

  const report = buildMarkdown(results, boardResults);
  const summary = buildMetricsSummary(results, boardResults);
  await fs.writeFile(path.join(OUTPUT_DIR, "baseline.json"), JSON.stringify({ seed: seedData, results, boardResults }, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, "metrics.json"), JSON.stringify({
    schema: "gsam.metrics.s2/v1",
    measuredAt: new Date().toISOString(),
    runsPerScenario: RUNS,
    boardIssueCount: seedData.boardIssueCount,
    s2: summary,
  }, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, "baseline.md"), report);
  console.log(`\n${report}\n`);
});
