#!/usr/bin/env node
// One command for UI evidence: start an isolated sandbox, seed demo data,
// capture routes at desktop and phone width (light and dark), write an index
// and a contact sheet, optionally attach the files to a task, and always stop
// the sandbox this script started. See "Sandbox screenshots" in
// doc/DEVELOPING.md. Run with `pnpm screenshots --help`.
//
// Process safety: the sandbox is started with `pnpm dev:once --data-dir <dir>`
// in its own process group and stopped with `pnpm dev:stop --data-dir <dir>`,
// then by the PID this script recorded. Nothing is ever stopped by name or
// pattern.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROUTES,
  THEME_STORAGE_KEY,
  USAGE,
  VIEWPORTS,
  buildContactSheetHtml,
  buildIndexMarkdown,
  parseArgs,
  resolveFromRoot,
  resolveRoute,
  shotFileName,
  timestampSlug,
} from "./sandbox-screenshots-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_PORT = 3100;
const READY_TIMEOUT_MS = 15 * 60_000;
const STOP_WAIT_MS = 45_000;

// The sandbox must never see the caller's instance, database or agent identity.
const SANDBOX_ENV_DROP = [
  "DATABASE_URL",
  "PORT",
  "GSAM_HOME",
  "GSAM_CONFIG",
  "GSAM_CONTEXT",
  "GSAM_INSTANCE_ID",
  "PAPERCLIP_HOME",
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_CONTEXT",
  "PAPERCLIP_INSTANCE_ID",
];

function log(message) {
  console.log(`[screenshots] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => server.close(() => resolve(true)));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (port === LIVE_PORT) continue;
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port found from ${start}`);
}

class Sandbox {
  constructor({ dataDir, port, logFile }) {
    this.dataDir = dataDir;
    this.port = port;
    this.logFile = logFile;
    this.child = null;
    this.pid = null;
    this.exitInfo = null;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  start() {
    const env = { ...process.env };
    for (const key of SANDBOX_ENV_DROP) delete env[key];
    Object.assign(env, {
      PORT: String(this.port),
      HEARTBEAT_SCHEDULER_ENABLED: "false",
      GSAM_DB_BACKUP_ENABLED: "false",
      GSAM_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const out = fs.openSync(this.logFile, "a");
    this.child = spawn("pnpm", ["dev:once", "--data-dir", this.dataDir], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", out, out],
      // Its own process group, so the stop below can reach exactly the tree
      // this script started and nothing else.
      detached: process.platform !== "win32",
    });
    fs.closeSync(out);
    this.pid = this.child.pid;
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });
    log(`sandbox starting: pid ${this.pid}, port ${this.port}, data dir ${path.relative(repoRoot, this.dataDir)}, log ${path.relative(repoRoot, this.logFile)}`);
  }

  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastNote = 0;
    while (Date.now() < deadline) {
      if (this.exitInfo) {
        const rootHint = runsAsRoot()
          ? "\nThis process runs as root, and embedded PostgreSQL (initdb) refuses to run as root. Run as an unprivileged user, or start a sandbox yourself and pass --base-url."
          : "";
        throw new Error(`sandbox exited before it was ready (code ${this.exitInfo.code}, signal ${this.exitInfo.signal}); see ${this.logFile}\n${tailFile(this.logFile, 25)}${rootHint}`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() - lastNote > 30_000) {
        lastNote = Date.now();
        log("waiting for the sandbox to answer /api/health (the first start builds the server and UI)...");
      }
      await sleep(1000);
    }
    throw new Error(`sandbox not ready after ${READY_TIMEOUT_MS / 1000}s; see ${this.logFile}`);
  }

  async stop() {
    if (!this.pid) return;
    log(`stopping the sandbox (pnpm dev:stop --data-dir ${path.relative(repoRoot, this.dataDir)})`);
    const env = { ...process.env };
    for (const key of SANDBOX_ENV_DROP) delete env[key];
    spawnSync("pnpm", ["dev:stop", "--data-dir", this.dataDir], { cwd: repoRoot, env, stdio: "ignore", timeout: 90_000 });
    // Then the process group this script started, by its recorded PID.
    const signalGroup = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-this.pid, signal);
        else process.kill(this.pid, signal);
      } catch {
        // already gone
      }
    };
    if (this.groupAlive()) signalGroup("SIGTERM");
    const deadline = Date.now() + STOP_WAIT_MS;
    while (this.groupAlive() && Date.now() < deadline) await sleep(500);
    if (this.groupAlive()) {
      log(`sandbox group ${this.pid} still running after ${STOP_WAIT_MS / 1000}s; sending SIGKILL`);
      signalGroup("SIGKILL");
      await sleep(1000);
    }
    log(this.groupAlive() ? `WARNING: sandbox process group ${this.pid} is still running` : `sandbox stopped (pid ${this.pid} gone)`);
  }

  groupAlive() {
    if (process.platform === "win32") return isAlive(this.pid);
    try {
      process.kill(-this.pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }
}

function runsAsRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function tailFile(file, lines) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.includes("Unsupported engine")).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function api(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", origin: baseUrl },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Demo data through the public API, the same calls the board makes. Only the
// company is required; the rest is best effort so a schema change in one
// entity does not cost the whole capture.
async function seedDemoData(baseUrl) {
  const call = (method, route, body) => api(baseUrl, method, route, body);
  const company = await call("POST", "/api/companies", {
    name: "Northwind Robotics",
    description: "Demo company seeded by pnpm screenshots.",
  });
  const ids = { company: company.id };
  const warnings = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      warnings.push(`${label}: ${error.message}`);
      return null;
    }
  };
  const idle = { heartbeat: { enabled: false, wakeOnDemand: false } };
  const agent = (name, role, title, reportsTo) =>
    attempt(`agent ${name}`, () =>
      call("POST", `/api/companies/${company.id}/agents`, {
        name,
        role,
        title,
        reportsTo: reportsTo ?? null,
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: idle,
      }),
    );
  const ceo = await agent("Ada", "ceo", "Chief Executive");
  const engineer = await agent("Grace", "engineer", "Lead Engineer", ceo?.id);
  await agent("Linus", "engineer", "Platform Engineer", ceo?.id);
  await agent("Marie", "designer", "Product Designer", ceo?.id);
  if (ceo) ids.agent = ceo.id;

  const project = await attempt("project", () =>
    call("POST", `/api/companies/${company.id}/projects`, {
      name: "Warehouse Rover",
      description: "Autonomous rover for the north warehouse.",
    }),
  );
  if (project) ids.project = project.id;

  const issues = [
    { title: "Draft the launch plan for the rover pilot", status: "todo", priority: "high" },
    { title: "Calibrate lidar on rover unit 3", status: "backlog", priority: "medium", assigneeAgentId: engineer?.id },
    { title: "Write the safety checklist for floor staff", status: "backlog", priority: "low" },
    { title: "Pick a battery supplier", status: "done", priority: "medium" },
    { title: "Review the charging dock design", status: "cancelled", priority: "low" },
  ];
  for (const input of issues) {
    const issue = await attempt(`issue "${input.title}"`, () =>
      call("POST", `/api/companies/${company.id}/issues`, {
        ...input,
        description: "Seeded by pnpm screenshots for UI evidence.",
        ...(project ? { projectId: project.id } : {}),
      }),
    );
    if (issue && !ids.issue) ids.issue = issue.identifier ?? issue.id;
  }
  return { companyPrefix: company.issuePrefix, ids, warnings };
}

async function findExistingCompany(baseUrl) {
  const companies = await api(baseUrl, "GET", "/api/companies");
  const list = Array.isArray(companies) ? companies : companies?.companies ?? [];
  if (list.length === 0) throw new Error(`${baseUrl} has no company; pass --seed to create demo data`);
  return { companyPrefix: list[0].issuePrefix, ids: { company: list[0].id }, warnings: [] };
}

async function launchBrowser() {
  const { chromium } = await import("@playwright/test");
  let libEnv = {};
  if (process.platform === "linux") {
    // Same no-root library fetch as scripts/preview-shot.mjs (GRE-1065).
    try {
      const { ensureChromiumLibs, headlessShell } = await import("./chromium-libs.mjs");
      const binary = headlessShell(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright"));
      if (binary) libEnv = ensureChromiumLibs(binary);
    } catch (error) {
      log(`note: could not prepare Chromium libraries (${error.message.split("\n")[0]}); trying the browser as is`);
    }
  }
  const launchOptions = { headless: true, env: { ...process.env, ...libEnv } };
  const explicit = process.env.GSAM_SCREENSHOTS_CHROMIUM?.trim();
  if (explicit) return chromium.launch({ ...launchOptions, executablePath: explicit });
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (!String(error.message).includes("Executable doesn't exist")) throw error;
    // The installed browser build can lag the @playwright/test version. Use
    // the newest installed build rather than downloading one.
    const fallback = findInstalledChromium(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright"));
    if (!fallback) throw error;
    log(`note: Playwright's own Chromium build is not installed; using ${fallback}`);
    return chromium.launch({ ...launchOptions, executablePath: fallback });
  }
}

function findInstalledChromium(browsersPath) {
  let entries;
  try {
    entries = fs.readdirSync(browsersPath);
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    const match = entry.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
    if (!match) continue;
    const relative = match[1] === "chromium"
      ? ["chrome-linux/chrome", "chrome-linux64/chrome"]
      : ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"];
    for (const rel of relative) {
      const file = path.join(browsersPath, entry, rel);
      if (fs.existsSync(file)) candidates.push({ file, build: Number(match[2]), shell: match[1] !== "chromium" });
    }
  }
  candidates.sort((a, b) => b.build - a.build || Number(b.shell) - Number(a.shell));
  return candidates[0]?.file ?? null;
}

async function capture({ baseUrl, targets, options, outDir }) {
  const browser = await launchBrowser();
  const shots = [];
  try {
    for (const theme of options.themes) {
      for (const viewportName of options.viewports) {
        const { width, height, ...device } = VIEWPORTS[viewportName];
        const context = await browser.newContext({
          viewport: { width, height },
          ...device,
          deviceScaleFactor: options.scale,
          colorScheme: theme,
          locale: "en-GB",
        });
        await context.addInitScript(
          ([key, value]) => {
            try {
              window.localStorage.setItem(key, value);
            } catch {
              // storage blocked; the colour scheme still applies
            }
          },
          [THEME_STORAGE_KEY, theme],
        );
        const page = await context.newPage();
        let errors = 0;
        page.on("console", (message) => {
          if (message.type() === "error") errors += 1;
        });
        page.on("pageerror", () => {
          errors += 1;
        });
        for (const target of targets) {
          const file = shotFileName(target.route, viewportName, theme);
          errors = 0;
          const shot = { route: target.route, path: target.path, viewport: viewportName, theme, file, consoleErrors: 0, error: null };
          try {
            await page.goto(`${baseUrl}${target.path}`, { waitUntil: "networkidle", timeout: 120_000 });
            await page.waitForTimeout(1500);
            await page.screenshot({ path: path.join(outDir, file), fullPage: false });
            shot.consoleErrors = errors;
            log(`captured ${file}`);
          } catch (error) {
            shot.error = error.message.split("\n")[0];
            log(`failed ${file}: ${shot.error}`);
          }
          shots.push(shot);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}

function attachFiles(issueId, files) {
  const missing = ["GSAM_API_URL", "GSAM_API_KEY", "GSAM_RUN_ID", "GSAM_COMPANY_ID"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    log(`--attach ${issueId}: skipped, ${missing.join(", ")} not set. Upload by hand with skills/paperclip/scripts/paperclip-upload-artifact.sh`);
    return false;
  }
  const helper = path.join(repoRoot, "skills/paperclip/scripts/paperclip-upload-artifact.sh");
  let failures = 0;
  for (const { file, title, workProduct } of files) {
    const args = [helper, file, "--issue-id", issueId, "--title", title];
    if (!workProduct) args.push("--no-work-product");
    const result = spawnSync("bash", args, { cwd: repoRoot, stdio: "inherit" });
    if (result.status !== 0) failures += 1;
  }
  log(failures ? `--attach: ${failures} upload(s) failed` : `--attach: uploaded ${files.length} file(s) to ${issueId}`);
  return failures === 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[screenshots] ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const stamp = timestampSlug();
  const outDir = resolveFromRoot(repoRoot, options.out ?? `tmp/screenshots/${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  let sandbox = null;
  let removeDataDir = false;
  const onSignal = (signal) => {
    log(`${signal} received; stopping the sandbox first`);
    (sandbox ? sandbox.stop() : Promise.resolve()).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let exitCode = 0;
  try {
    let baseUrl = options.baseUrl;
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (Number(url.port || 80) === LIVE_PORT) {
        throw new Error(`refusing ${baseUrl}: port ${LIVE_PORT} is the live app. Capture a sandbox instead.`);
      }
    } else {
      const dataDir = resolveFromRoot(repoRoot, options.dataDir ?? `tmp/screenshots-${stamp}`);
      removeDataDir = !options.dataDir && !options.keepData;
      const port = options.port ?? (await findFreePort(3300));
      if (port === LIVE_PORT) throw new Error(`port ${LIVE_PORT} is the live app`);
      if (!(await portIsFree(port))) throw new Error(`port ${port} is in use`);
      if (runsAsRoot()) {
        log("warning: running as root; embedded PostgreSQL refuses to start as root, so the sandbox will probably fail");
      }
      sandbox = new Sandbox({ dataDir, port, logFile: path.join(outDir, "sandbox.log") });
      sandbox.start();
      await sandbox.waitUntilReady();
      baseUrl = sandbox.baseUrl;
      log(`sandbox ready at ${baseUrl}`);
    }

    const seed = options.seed ? await seedDemoData(baseUrl) : await findExistingCompany(baseUrl);
    for (const warning of seed.warnings) log(`seed warning: ${warning}`);
    log(`company prefix ${seed.companyPrefix}`);

    const routes = options.routes ?? DEFAULT_ROUTES;
    const resolved = routes.map((route) => resolveRoute(route, seed));
    const targets = resolved.filter((item) => item.path);
    const skipped = resolved.filter((item) => !item.path);
    for (const item of skipped) log(`skipping ${item.route}: ${item.error}`);
    if (targets.length === 0) throw new Error("no route could be resolved");

    const shots = await capture({ baseUrl, targets, options, outDir });
    const meta = { title: "Sandbox screenshots", baseUrl, generatedAt: new Date().toISOString(), shots, skipped };
    fs.writeFileSync(path.join(outDir, "index.md"), buildIndexMarkdown(meta));
    fs.writeFileSync(path.join(outDir, "contact-sheet.html"), buildContactSheetHtml(meta));
    const ok = shots.filter((shot) => !shot.error);
    log(`wrote ${ok.length}/${shots.length} screenshots, index.md and contact-sheet.html to ${outDir}`);
    if (ok.length < shots.length) exitCode = 1;

    if (options.attach) {
      const files = [
        { file: path.join(outDir, "index.md"), title: "Screenshots index", workProduct: true },
        ...ok.map((shot) => ({
          file: path.join(outDir, shot.file),
          title: `${shot.route} (${shot.viewport}, ${shot.theme})`,
          workProduct: false,
        })),
      ];
      if (!attachFiles(options.attach, files)) log(`files stay in ${outDir}`);
    }
  } catch (error) {
    console.error(`[screenshots] ${error.message}`);
    exitCode = 1;
  } finally {
    if (sandbox) await sandbox.stop();
    if (sandbox && removeDataDir) {
      fs.rmSync(sandbox.dataDir, { recursive: true, force: true });
      log(`removed ${path.relative(repoRoot, sandbox.dataDir)}`);
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  log(`output: ${outDir}`);
  return exitCode;
}

process.exitCode = await main();
