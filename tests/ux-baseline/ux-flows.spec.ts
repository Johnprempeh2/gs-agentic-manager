import fs from "node:fs/promises";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

// UX baseline (GRE-337): time, clicks, typing, scrolls and screens for the top
// five flows, at desktop and phone width, against a fresh seeded instance.
// Every user action goes through the Recorder, so the counts are the actions
// the script needed, not a guess.

const requestedRuns = Number(process.env.GSAM_UX_BASELINE_RUNS ?? 5);
const RUNS = Number.isFinite(requestedRuns) ? Math.max(3, Math.floor(requestedRuns)) : 5;
const OUTPUT_DIR = path.resolve(process.cwd(), "test-results/ux-baseline");
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, "screens");
const STEP_TIMEOUT_MS = 30_000;
// The scripted Everest runs a local process per turn; give it room on a busy machine.
const AGENT_TIMEOUT_MS = 90_000;

type ViewportName = "desktop" | "phone";
const VIEWPORTS: Record<ViewportName, { width: number; height: number; isMobile: boolean; hasTouch: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
};
const requestedViewports = process.env.GSAM_UX_BASELINE_VIEWPORTS?.split(",").map((v) => v.trim()).filter(Boolean);
const VIEWPORT_NAMES = (requestedViewports?.length ? requestedViewports : Object.keys(VIEWPORTS)) as ViewportName[];

type FlowId =
  | "1-ask-everest"
  | "2-answer-decision"
  | "3a-needs-me-inbox"
  | "3b-needs-me-focus"
  | "4-task-latest-result"
  | "5-overnight-activity";
const requestedFlows = process.env.GSAM_UX_BASELINE_FLOWS?.split(",").map((v) => v.trim()).filter(Boolean);

type StepTiming = { label: string; ms: number };
type Sample = {
  flow: FlowId;
  viewport: ViewportName;
  run: number;
  homeLoadMs: number;
  totalMs: number;
  agentWaitMs: number;
  activeMs: number;
  clicks: number;
  typing: number;
  scrolls: number;
  screens: string[];
  steps: StepTiming[];
};

type Seed = {
  companyId: string;
  prefix: string;
  everest: { id: string; name: string };
  ridge: { id: string; name: string };
  needsMeTitle: string;
  resultTask: { id: string; title: string; resultText: string };
};

class Recorder {
  clicks = 0;
  typing = 0;
  scrolls = 0;
  agentWaitMs = 0;
  screens: string[] = [];
  steps: StepTiming[] = [];
  private stepStart = performance.now();
  private readonly start = performance.now();

  constructor(
    private readonly page: Page,
    private readonly shots: string | null,
  ) {
    this.screens.push(new URL(page.url()).pathname);
  }

  async click(target: Locator) {
    this.clicks += 1;
    await target.click();
  }

  async type(target: Locator, text: string) {
    this.typing += 1;
    await target.fill(text);
  }

  /**
   * The user has to scroll when the thing they want is below the fold or under
   * fixed chrome (the phone tab bar, a sticky composer). Seen means the target
   * is the topmost element at its own centre.
   */
  async bringIntoView(target: Locator) {
    const seen = () => target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + Math.min(box.height / 2, 12);
      if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (element === hit || element.contains(hit)));
    }, undefined, { timeout: STEP_TIMEOUT_MS });
    if (await seen()) return;
    this.scrolls += 1;
    await target.scrollIntoViewIfNeeded();
    if (await seen()) return;
    // Still under fixed chrome after the browser's scroll: one more nudge, as a thumb would.
    await this.page.mouse.wheel(0, 200);
  }

  /** Ends a step once `ready` is visible: the time the user waited for that screen. */
  async step(label: string, ready: Locator, options: { agentWait?: boolean; timeout?: number } = {}) {
    await expect(ready).toBeVisible({ timeout: options.timeout ?? STEP_TIMEOUT_MS });
    const now = performance.now();
    const ms = now - this.stepStart;
    this.steps.push({ label, ms });
    // A screen is a page the user lands on; redirects on the way (/inbox → /inbox/mine) are not.
    const pathname = new URL(this.page.url()).pathname;
    if (this.screens.at(-1) !== pathname) this.screens.push(pathname);
    if (options.agentWait) this.agentWaitMs += ms;
    this.stepStart = now;
    if (this.shots) {
      await this.page.screenshot({ path: `${this.shots}-${String(this.steps.length).padStart(2, "0")}-${label}.png` });
      // Screenshot time is not user time.
      this.stepStart = performance.now();
      this.pausedMs += this.stepStart - now;
    }
  }

  private pausedMs = 0;

  finish() {
    const totalMs = performance.now() - this.start - this.pausedMs;
    return {
      totalMs,
      agentWaitMs: this.agentWaitMs,
      activeMs: totalMs - this.agentWaitMs,
      clicks: this.clicks,
      typing: this.typing,
      scrolls: this.scrolls,
      screens: this.screens,
      steps: this.steps,
    };
  }
}

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.url()} ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createAgent(request: APIRequestContext, companyId: string, name: string, role: string) {
  return json(await request.post(`/api/companies/${companyId}/agents`, {
    data: {
      name,
      role,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: [path.resolve("tests/ux-baseline/fixtures/ux-agent.mjs")], graceSec: 1 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    },
  }));
}

/** A task the scripted agent works in a real run: it posts `comments` and `interaction`, then applies `update`. */
function scripted(description: string, script: { comments?: string[]; interaction?: Record<string, unknown>; update?: Record<string, unknown> }) {
  return `${description}\n\nux-script: ${Buffer.from(JSON.stringify(script)).toString("base64url")}`;
}

async function waitForIssue(request: APIRequestContext, issueId: string, done: (issue: any) => boolean) {
  await expect.poll(async () => done(await json(await request.get(`/api/issues/${issueId}`))), {
    timeout: AGENT_TIMEOUT_MS,
    intervals: [500, 1000, 2000],
  }).toBe(true);
}

async function seed(request: APIRequestContext): Promise<Seed> {
  await json(await request.patch("/api/instance/settings/experimental", {
    data: { enableAgentChat: true, enableClassicTaskInterface: false },
  }));
  const company = await json(await request.post("/api/companies", { data: { name: `UX Baseline ${Date.now()}` } }));
  const companyId = company.id;
  const prefix = company.issuePrefix ?? company.prefix;

  const everest = await createAgent(request, companyId, "Everest", "ceo");
  const ridgeAgent = await createAgent(request, companyId, "Ridge", "engineer");
  const mica = await createAgent(request, companyId, "Mica", "designer");

  // A lived-in board: tasks across statuses, owned by the agents, each with a
  // little agent work on it (this is also the "overnight" activity for flow 5).
  // An agent may only leave a task where someone owns the next step, so the
  // background work ends in backlog or done.
  const statuses = ["backlog", "done"] as const;
  const background: string[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const status = statuses[index % statuses.length];
    const issue = await json(await request.post(`/api/companies/${companyId}/issues`, {
      data: {
        title: `Background task ${index}: ${["Tidy connector copy", "Speed up board load", "Refresh client deck", "Fix chat retry", "Write release notes"][index % 5]}`,
        description: scripted("Seeded background work for the UX baseline.", {
          comments: [`Worked on this overnight: step ${index} done.`],
          update: { status },
        }),
        status: "todo",
        priority: "medium",
        assigneeAgentId: index % 2 ? ridgeAgent.id : mica.id,
      },
    }));
    background.push(issue.id);
  }

  // Flow 3: Ridge asks John for a sign-off and hands the task to him.
  const needsMeTitle = "Sign off the Indago statement of work";
  const needsMe = await json(await request.post(`/api/companies/${companyId}/issues`, {
    data: {
      title: needsMeTitle,
      description: scripted("Ridge needs a signature before work starts.", {
        comments: ["John, this needs your sign-off today. The draft is attached to the task."],
        update: { assigneeAgentId: null, assigneeUserId: "local-board" },
      }),
      status: "todo",
      priority: "high",
      assigneeAgentId: ridgeAgent.id,
    },
  }));

  // Flow 4: a finished task whose latest comment is the result, under a thread of earlier comments.
  const resultTitle = "Compare server and local hosting cost";
  const resultText = "Result: the hosted server is cheaper for a one-year client once upkeep is counted.";
  const resultTask = await json(await request.post(`/api/companies/${companyId}/issues`, {
    data: {
      title: resultTitle,
      description: scripted("Cost breakdown, local box versus a hosted server, for one client over a year.", {
        comments: [
          ...Array.from({ length: 8 }, (_, index) => `Progress note ${index + 1}: ${"checked another line item and recorded the figure. ".repeat(4)}`),
          `${resultText}\n\nFull table in the output document.`,
        ],
        update: { status: "done" },
      }),
      status: "todo",
      priority: "medium",
      assigneeAgentId: ridgeAgent.id,
    },
  }));

  try {
    for (const id of background) {
      await expect.poll(async () => (await json(await request.get(`/api/issues/${id}/comments`))).length, {
        timeout: AGENT_TIMEOUT_MS,
        intervals: [500, 1000, 2000],
      }).toBeGreaterThan(0);
    }
    await waitForIssue(request, needsMe.id, (issue) => issue.assigneeUserId === "local-board");
    await waitForIssue(request, resultTask.id, (issue) => issue.status === "done");
  } catch (error) {
    // Say why the scripted agents did not finish, rather than only that they did not.
    const runs = await json(await request.get(`/api/companies/${companyId}/heartbeat-runs`));
    const counts = (runs as any[]).reduce((acc, run) => ({ ...acc, [run.status]: (acc[run.status] ?? 0) + 1 }), {} as Record<string, number>);
    const failed = (runs as any[]).find((run) => run.status === "failed");
    const log = failed ? (await (await request.get(`/api/heartbeat-runs/${failed.id}/log`)).text()).slice(-1500) : "";
    throw new Error(`Seeding agents did not finish. Runs: ${JSON.stringify(counts)}\n${log}\n${error}`);
  }

  // Background decisions that stay open across every sample, asked by Mica in her own runs.
  for (let index = 1; index <= 3; index += 1) {
    const issue = await json(await request.post(`/api/companies/${companyId}/issues`, {
      data: {
        title: `Background decision ${index}`,
        description: scripted("Mica needs a choice before going on.", {
          interaction: {
            kind: "ask_user_questions",
            continuationPolicy: "wake_assignee",
            payload: {
              version: 1,
              questions: [{ id: "pick", prompt: `Which option for background decision ${index}?`, selectionMode: "single", required: true, options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }],
            },
          },
          update: { status: "in_review" },
        }),
        status: "todo",
        assigneeAgentId: mica.id,
      },
    }));
    await waitForIssue(request, issue.id, (current) => current.status === "in_review");
  }

  return {
    companyId,
    prefix,
    everest: { id: everest.id, name: everest.name },
    ridge: { id: ridgeAgent.id, name: ridgeAgent.name },
    needsMeTitle,
    resultTask: { id: resultTask.id, title: resultTitle, resultText },
  };
}

/** One fresh decision per sample, asked by Ridge in a real run, so every sample answers the same kind of card. */
async function seedDecision(request: APIRequestContext, seedData: Seed, label: string) {
  const issue = await json(await request.post(`/api/companies/${seedData.companyId}/issues`, {
    data: {
      title: `Approve the onboarding plan ${label}`,
      description: scripted("Ridge drafted the onboarding plan and needs a yes before starting.", {
        interaction: {
          kind: "request_confirmation",
          continuationPolicy: "wake_assignee",
          payload: { version: 1, prompt: `Approve the onboarding plan ${label}?`, acceptLabel: "Approve", rejectLabel: "Revise" },
        },
        update: { status: "in_review" },
      }),
      status: "todo",
      assigneeAgentId: seedData.ridge.id,
    },
  }));
  await waitForIssue(request, issue.id, (current) => current.status === "in_review");
  return issue;
}

/** Desktop uses the sidebar; phone uses the bottom tab bar, or the drawer for anything not on it. */
function nav(page: Page, viewport: ViewportName) {
  if (viewport === "desktop") {
    const sidebar = page.locator("aside, nav").filter({ has: page.getByRole("link", { name: /^Dashboard/ }) }).first();
    return { link: (name: RegExp) => sidebar.getByRole("link", { name }).first() };
  }
  const tabs = page.getByRole("navigation", { name: "Mobile navigation" });
  return { link: (name: RegExp) => tabs.getByRole("link", { name }).first() };
}

type FlowContext = { page: Page; rec: Recorder; viewport: ViewportName; seed: Seed; label: string };

/** Untimed set-up a flow needs before each sample, done before the app opens. */
const PREPARE: Partial<Record<FlowId, (request: APIRequestContext, seedData: Seed, label: string) => Promise<unknown>>> = {
  "2-answer-decision": seedDecision,
};

const FLOWS: Record<FlowId, (ctx: FlowContext) => Promise<void>> = {
  async "1-ask-everest"({ page, rec, viewport, label }) {
    const chatLink = viewport === "desktop"
      ? page.getByRole("region", { name: "Chats" }).getByRole("link", { name: /Everest/ }).first()
      : page.getByRole("link", { name: "Chat with Everest" });
    await rec.click(chatLink);
    const composer = page.getByTestId("task-chat-composer-input").last().locator('[contenteditable="true"],textarea').first();
    await rec.step("chat-open", composer);
    const ask = `Draft a one-page welcome note for new clients ${label}`;
    await rec.click(composer);
    await rec.type(composer, ask);
    await rec.click(page.getByTestId("task-chat-composer-send").last());
    // Earlier samples left replies in the same chat; wait for the one that names this request.
    const taskLink = page.getByTestId("task-chat-agent-bubble").filter({ hasText: ask }).last().getByRole("link").first();
    await rec.step("agent-reply", taskLink, { agentWait: true, timeout: AGENT_TIMEOUT_MS });
    await rec.bringIntoView(taskLink);
    await rec.click(taskLink);
    await rec.step("task-open", page.getByRole("heading", { name: ask }).first());
  },

  async "2-answer-decision"({ page, rec, viewport, label }) {
    await rec.click(nav(page, viewport).link(/Decisions/));
    const card = page.getByLabel(`Approve the onboarding plan ${label}`, { exact: false }).first();
    await rec.step("decisions-open", card);
    const approve = card.getByRole("button", { name: "Approve", exact: true });
    await rec.bringIntoView(approve);
    await rec.click(approve);
    await expect(card).toBeHidden({ timeout: STEP_TIMEOUT_MS });
    await rec.step("decision-cleared", page.getByRole("heading", { name: /Decisions/ }).first());
  },

  async "3a-needs-me-inbox"({ page, rec, viewport, seed: seedData }) {
    await rec.click(nav(page, viewport).link(/Inbox/));
    const mine = page.getByRole("tab", { name: /^Mine/ });
    await rec.step("inbox-open", mine);
    if ((await mine.getAttribute("aria-selected")) !== "true") {
      await rec.click(mine);
    }
    const row = page.getByText(seedData.needsMeTitle).first();
    await rec.step("needs-me-visible", row);
    await rec.bringIntoView(row);
  },

  async "3b-needs-me-focus"({ page, rec, viewport }) {
    await rec.click(nav(page, viewport).link(/Decisions/));
    const focus = page.getByRole("group", { name: "Decisions view" }).getByRole("button", { name: /Focus/ });
    await rec.step("decisions-open", focus);
    await rec.click(focus);
    await rec.step("focus-first-item", page.getByRole("progressbar", { name: "Decisions done" }));
  },

  async "4-task-latest-result"({ page, rec, viewport, seed: seedData }) {
    await rec.click(nav(page, viewport).link(viewport === "desktop" ? /Agent tasks/ : /Tasks/));
    const chips = page.getByRole("group", { name: "Show tasks" });
    // The dashboard links the same tasks (Open tasks, Recent runs), so look only
    // inside the page once it holds the task list's chips (GRE-372).
    const list = page.locator("#main-content").filter({ has: chips });
    const row = list.getByRole("link", { name: new RegExp(seedData.resultTask.title) }).first();
    // Ready once the list has rows: the open task waiting on John is always in the default view.
    await rec.step("tasks-open", list.getByRole("link", { name: new RegExp(seedData.needsMeTitle) }).first());
    const doneChip = chips.getByRole("button", { name: "Done", exact: true });
    if ((await row.count()) === 0) {
      // Only needed when the default view hides finished tasks (it opened on Active before GRE-359).
      await rec.click(doneChip);
      await expect(doneChip).toHaveAttribute("aria-pressed", "true");
      await rec.step("done-filter", row);
    }
    await rec.bringIntoView(row);
    await rec.click(row);
    const result = page.getByText(seedData.resultTask.resultText).last();
    await rec.step("task-open", page.getByRole("heading", { name: seedData.resultTask.title }).first());
    await expect(result).toBeAttached({ timeout: STEP_TIMEOUT_MS });
    await rec.bringIntoView(result);
    await rec.step("result-visible", result);
  },

  async "5-overnight-activity"({ page, rec, viewport }) {
    if (viewport === "phone") {
      await rec.click(page.getByRole("button", { name: "Open sidebar" }));
      const audit = page.getByRole("link", { name: /^Audit/ }).first();
      await rec.step("drawer-open", audit);
      await rec.click(audit);
    } else {
      await rec.click(nav(page, viewport).link(/Audit/));
    }
    const agentTab = page.getByRole("tab", { name: "Agent Actions" });
    await rec.step("audit-open", agentTab);
    await rec.click(agentTab);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");
    // Done when the newest agent action is on screen, not just loaded below the filters.
    const newest = page.getByRole("list", { name: "Audit activity" }).getByRole("listitem").filter({ hasText: /Ridge|Mica|Everest/ }).first();
    await rec.step("agent-actions", newest);
    await rec.bringIntoView(newest);
  },
};

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
// Nearest-rank; with five samples p95 is the slowest one.
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function runSample(browser: Browser, baseURL: string, flow: FlowId, viewport: ViewportName, run: number, seedData: Seed, request: APIRequestContext): Promise<Sample> {
  const context = await browser.newContext({ baseURL, viewport: { width: VIEWPORTS[viewport].width, height: VIEWPORTS[viewport].height }, isMobile: VIEWPORTS[viewport].isMobile, hasTouch: VIEWPORTS[viewport].hasTouch });
  const page = await context.newPage();
  const label = `${viewport}-${run}-${Date.now()}`;
  try {
    await PREPARE[flow]?.(request, seedData, label);
    // Every sample starts from a cold load of the home screen, like opening the app.
    const homeStart = performance.now();
    await page.goto(`/${seedData.prefix}/dashboard`);
    await expect(nav(page, viewport).link(/Decisions/)).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    const homeLoadMs = performance.now() - homeStart;

    const shots = run === 1 ? path.join(SCREENSHOT_DIR, `${viewport}-${flow}`) : null;
    if (shots) await page.screenshot({ path: `${shots}-00-home.png` });
    const rec = new Recorder(page, shots);
    await FLOWS[flow]({ page, rec, viewport, seed: seedData, label });
    return { flow, viewport, run, homeLoadMs, ...rec.finish() };
  } catch (error) {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `FAILED-${viewport}-${flow}-${run}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

function summarize(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.flow}|${sample.viewport}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map((group) => {
    const pick = (fn: (s: Sample) => number) => ({ median: Math.round(median(group.map(fn))), p95: Math.round(percentile(group.map(fn), 95)) });
    const stepLabels = group[0].steps.map((s) => s.label);
    return {
      flow: group[0].flow,
      viewport: group[0].viewport,
      samples: group.length,
      totalMs: pick((s) => s.totalMs),
      activeMs: pick((s) => s.activeMs),
      agentWaitMs: pick((s) => s.agentWaitMs),
      homeLoadMs: pick((s) => s.homeLoadMs),
      // Counts are deterministic for a scripted path; report the most common value.
      clicks: median(group.map((s) => s.clicks)),
      typing: median(group.map((s) => s.typing)),
      scrolls: median(group.map((s) => s.scrolls)),
      screens: median(group.map((s) => s.screens.length)),
      screenPath: group[0].screens.map((p) => p.replace(/^\/[^/]+/, "") || "/"),
      steps: stepLabels.map((label, index) => ({ label, ...pick((s) => s.steps[index]?.ms ?? 0) })),
    };
  });
}

function markdown(summary: ReturnType<typeof summarize>, meta: Record<string, unknown>) {
  const lines = [
    "# UX baseline: top five flows",
    "",
    `Recorded ${meta.recordedAt} · ${meta.samplesPerCell} samples per flow and viewport · desktop 1440×900, phone 390×844 · built UI, fresh seeded local instance.`,
    "",
    "Time is from the home screen being ready to the goal being on screen. Active time leaves out the wait for the agent to reply. Home load is the cold load of the dashboard before the flow starts.",
    "",
    "| Flow | Viewport | Clicks/taps | Typing | Scrolls | Screens | Total median | Total p95 | Active median | Active p95 | Home load p95 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.map((row) => `| ${row.flow} | ${row.viewport} | ${row.clicks} | ${row.typing} | ${row.scrolls} | ${row.screens} | ${row.totalMs.median} ms | ${row.totalMs.p95} ms | ${row.activeMs.median} ms | ${row.activeMs.p95} ms | ${row.homeLoadMs.p95} ms |`),
    "",
    "## Steps (median / p95)",
    "",
    ...summary.flatMap((row) => [
      `### ${row.flow} · ${row.viewport}`,
      "",
      `Screens: ${row.screenPath.join(" → ")}`,
      "",
      ...row.steps.map((step) => `- ${step.label}: ${step.median} ms / ${step.p95} ms`),
      "",
    ]),
  ];
  return lines.join("\n");
}

test("UX baseline: top five flows on desktop and phone", async ({ browser, request, baseURL }) => {
  test.setTimeout(60 * 60_000);
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const seedData = await seed(request);
  const flows = (requestedFlows?.length ? requestedFlows : Object.keys(FLOWS)) as FlowId[];
  const samples: Sample[] = [];
  for (const viewport of VIEWPORT_NAMES) {
    for (const flow of flows) {
      for (let run = 1; run <= RUNS; run += 1) {
        const sample = await runSample(browser, baseURL!, flow, viewport, run, seedData, request);
        samples.push(sample);
        console.log(`${viewport} ${flow} #${run}: ${Math.round(sample.totalMs)} ms, ${sample.clicks} clicks, ${sample.screens.length} screens`);
      }
    }
  }
  const summary = summarize(samples);
  const meta = { recordedAt: new Date().toISOString(), samplesPerCell: RUNS, viewports: VIEWPORTS };
  await fs.writeFile(path.join(OUTPUT_DIR, "baseline.json"), `${JSON.stringify({ meta, summary, samples }, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT_DIR, "baseline.md"), `${markdown(summary, meta)}\n`);
});
