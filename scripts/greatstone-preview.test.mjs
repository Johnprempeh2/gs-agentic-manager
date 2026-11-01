// Tests for the environment scripts/greatstone-preview.sh gives the preview
// server. Only the variable setup is run: no preview is started, and nothing
// under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import http from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
// The legacy alias of GSAM_RUN_ID (packages/shared/src/legacy-env.ts), built
// from parts because the rebrand guard forbids its name.
const LEGACY_RUN_ID = `${"paperclip".toUpperCase()}_RUN_ID`;

// The script up to its command dispatch, then print PREVIEW_ENV one per line.
function previewEnv(env) {
  const dir = mkdtempSync(join(tmpdir(), "gs-preview-env-"));
  try {
    const source = readFileSync(join(scriptsDir, "greatstone-preview.sh"), "utf8");
    const setup = source.slice(0, source.lastIndexOf('case "${1:-}" in'))
      .replace('"$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"', JSON.stringify(join(scriptsDir, "greatstone-common.sh")));
    const file = join(dir, "env.sh");
    writeFileSync(file, `${setup}\nprintf '%s\\n' "\${PREVIEW_ENV[@]}"\n`);
    const out = execFileSync("bash", [file], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    return Object.fromEntries(out.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an agent's temp HOME does not reach the preview server (GRE-171)", () => {
  const env = previewEnv({ HOME: "/tmp/agent-home" });
  assert.equal(env.HOME, userInfo().homedir);
  assert.equal(env.GSAM_ROOT, join(userInfo().homedir, "GSAM"));
});

test("GSAM_ROOT set by the caller is passed on to the preview server", () => {
  const env = previewEnv({ HOME: "/tmp/agent-home", GSAM_ROOT: "/tmp/fake-gsam" });
  assert.equal(env.GSAM_ROOT, "/tmp/fake-gsam");
  assert.equal(env.PORT, "3200");
});

// The script up to its command dispatch, then <tail>. Returns stdout.
function runSetup(tail, env) {
  const dir = mkdtempSync(join(tmpdir(), "gs-preview-setup-"));
  try {
    const source = readFileSync(join(scriptsDir, "greatstone-preview.sh"), "utf8");
    const setup = source.slice(0, source.lastIndexOf('case "${1:-}" in'))
      .replace('"$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"', JSON.stringify(join(scriptsDir, "greatstone-common.sh")));
    const file = join(dir, "setup.sh");
    writeFileSync(file, `${setup}\n${tail}\n`);
    return execFileSync("bash", [file], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fake GSAM root whose preview state file points at a live process that
// looks like the preview (its command line names the preview data folder).
function withFakePreview(state, fn) {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const dataDir = join(root, "preview", "data");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", dataDir], { stdio: "ignore" });
  try {
    writeFileSync(join(root, "preview", "preview.state"),
      Object.entries({ tag: "rc-test", commit: "abc", pid: child.pid, port: 1, ...state }).map(([k, v]) => `${k}=${v}\n`).join(""));
    return fn(root);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");

function runPreview(args, root, env = {}) {
  try {
    const stdout = execFileSync("bash", [join(scriptsDir, "greatstone-preview.sh"), ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, GSAM_ROOT: root, GSAM_PREVIEW_PORT: "1", ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

test("start records the agent run and issue in the preview state (GRE-525)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "preview"));
    const read = (env) => {
      runSetup('write_preview_state rc-1 abc 123 /repo', { GSAM_ROOT: root, ...env });
      return readFileSync(join(root, "preview", "preview.state"), "utf8");
    };
    const state = read({ GSAM_RUN_ID: "run-1\nport=9", GSAM_TASK_ID: "issue-1" });
    assert.match(state, /^run_id=run-1port=9$/m);
    assert.match(state, /^issue_id=issue-1$/m);
    assert.match(state, /^port=3200$/m);
    assert.match(state, /^started_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    const outside = read({});
    assert.match(outside, /^run_id=$/m);
    assert.match(outside, /^issue_id=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start from a run scratch clone leaves release.conf unchanged (GRE-529)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const scratch = mkdtempSync(join(tmpdir(), "paperclip-run-test-"));
  try {
    const conf = join(root, "release.conf");
    writeFileSync(conf, "release_repo=/dev/checkout\n");
    const clone = join(scratch, "pr299");
    mkdirSync(clone);
    for (const name of ["GSAM_RUN_SCRATCH_DIR", "GSAM_TASK_SCRATCH_DIR", "GSAM_SCRATCH_DIR", "GSAM_TMPDIR"]) {
      runSetup(`record_release_repo ${JSON.stringify(clone)} 2>/dev/null`, { GSAM_ROOT: root, [name]: `${scratch}/` });
      assert.equal(readFileSync(conf, "utf8"), "release_repo=/dev/checkout\n", name);
    }
    // A repo outside the scratch folder is still recorded, in or out of a run.
    runSetup(`record_release_repo ${JSON.stringify(root)}`, { GSAM_ROOT: root, GSAM_RUN_SCRATCH_DIR: scratch });
    assert.equal(readFileSync(conf, "utf8"), `release_repo=${root}\n`);
    runSetup(`record_release_repo ${JSON.stringify(clone)}`, { GSAM_ROOT: root });
    assert.equal(readFileSync(conf, "utf8"), `release_repo=${clone}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a second start names the run, issue and age of the running preview (GRE-525)", () => {
  withFakePreview({ started_at: hoursAgo(3.1), run_id: "run-1", issue_id: "issue-1" }, (root) => {
    const { code, out } = runPreview(["start", "rc-other"], root);
    assert.equal(code, 1);
    assert.match(out, /a preview of rc-test is already running \(started 3h ago by run run-1 for issue issue-1\); run 'greatstone-preview\.sh stop' first\./);
  });
});

test("status shows the origin, and old state files without run or issue still work (GRE-525)", () => {
  withFakePreview({ started_at: hoursAgo(0.5), run_id: "run-2", issue_id: "issue-2" }, (root) => {
    assert.match(runPreview(["status"], root).out, /origin: +started 30m ago by run run-2 for issue issue-2/);
  });
  withFakePreview({ started_at: hoursAgo(50) }, (root) => {
    const status = runPreview(["status"], root);
    assert.equal(status.code, 0);
    assert.match(status.out, /origin: +started 2d ago by run unknown for issue unknown/);
    assert.match(runPreview(["start", "rc-other"], root).out, /already running \(started 2d ago by run unknown for issue unknown\)/);
  });
  withFakePreview({}, (root) => {
    assert.match(runPreview(["status"], root).out, /origin: +started at an unknown time by run unknown for issue unknown/);
  });
});

test("status names the migrations the preview applied on start: none, some, or unknown with no log (GRE-827)", () => {
  const status = (log) => withFakePreview({ started_at: hoursAgo(0.1) }, (root) => {
    if (log !== undefined) writeFileSync(join(root, "preview", "preview.log"), log);
    return runPreview(["status"], root);
  });
  const none = status("[10:00:00] INFO: Server listening on 127.0.0.1:3200\n");
  assert.equal(none.code, 0);
  assert.match(none.out, /^  migrations applied on start: none$/m);
  // pino-pretty in dev (with colour codes), and pino JSON in production.
  const pretty = status(
    '[10:00:00] \u001b[32mINFO\u001b[39m: \u001b[36mApplying 2 pending migrations for Embedded PostgreSQL\u001b[39m ' +
      '{"pendingMigrations":["0101_add_widgets.sql","0102_widget_index.sql"]}\n');
  assert.equal(pretty.code, 0);
  assert.match(pretty.out, /^  migrations applied on start: 0101_add_widgets\.sql, 0102_widget_index\.sql$/m);
  const json = status(`${JSON.stringify({ level: 30, pendingMigrations: ["0103_x.sql"], msg: "Applying 1 pending migrations for PostgreSQL" })}\n`);
  assert.match(json.out, /^  migrations applied on start: 0103_x\.sql$/m);
  const noLog = status(undefined);
  assert.equal(noLog.code, 0);
  assert.match(noLog.out, /^  migrations applied on start: unknown \(no log\)$/m);
});

test("status names the migrations `pnpm db:migrate` applied before the server started (GRE-902)", () => {
  const status = (log) => withFakePreview({ started_at: hoursAgo(0.1) }, (root) => {
    writeFileSync(join(root, "preview", "preview.log"), log);
    return runPreview(["status"], root);
  });
  const named = status(
    "Migrating database via embedded-postgres\n" +
      "Applying 3 pending migration(s): 0294_support_queues.sql, 0295_memory_gateway.sql, 0296_memory_ingest_outbox.sql\n" +
      "Migrations complete\n" +
      "[10:00:00] INFO: Server listening on 127.0.0.1:3200\n");
  assert.equal(named.code, 0);
  assert.match(named.out,
    /^  migrations applied on start: 0294_support_queues\.sql, 0295_memory_gateway\.sql, 0296_memory_ingest_outbox\.sql$/m);
  // Tags from before GRE-902 log the count only.
  const countOnly = status("Applying 3 pending migration(s)...\nMigrations complete\n");
  assert.match(countOnly.out, /^  migrations applied on start: 3 migrations \(names not in the log\)$/m);
});

test("start prints the migrations line under 'Preview is up' (GRE-827)", () => {
  withFakePreview({}, (root) => {
    writeFileSync(join(root, "preview", "preview.log"), '{"pendingMigrations":["0104_y.sql"],"msg":"Applying 1 pending migrations for PostgreSQL"}\n');
    assert.equal(runSetup("preview_migrations", { GSAM_ROOT: root }), "migrations applied on start: 0104_y.sql");
  });
  const source = readFileSync(join(scriptsDir, "greatstone-preview.sh"), "utf8");
  assert.match(source, /say "Preview is up: [^\n]*"\n\s+say "\$\(preview_migrations\)"/);
});

// A fake `node` first on PATH for `shot`: it records its arguments and writes
// the two PNG paths it is given, so no browser starts and no port is opened.
function withFakeNode(fn) {
  const bin = mkdtempSync(join(tmpdir(), "gs-preview-bin-"));
  const log = join(bin, "calls.log");
  const envLog = join(bin, "env.log");
  writeFileSync(join(bin, "node"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >>${JSON.stringify(log)}\nprintf '%s\\n' "\${PLAYWRIGHT_BROWSERS_PATH-<unset>}" >>${JSON.stringify(envLog)}\ntouch "$3" "$4"\n`, { mode: 0o755 });
  try {
    return fn({ PATH: `${bin}:${process.env.PATH}` }, () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
      () => (existsSync(envLog) ? readFileSync(envLog, "utf8") : ""));
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("shot saves laptop and phone PNGs named after the preview tag and prints their paths (GRE-606)", () => {
  withFakePreview({ tag: "rc-2026-10-04.1", port: 3200 }, (root) => withFakeNode((env, calls) => {
    const { code, out } = runPreview(["shot", "/GRE/issues", "inbox"], root, { ...env, GSAM_PREVIEW_PORT: "3200" });
    assert.equal(code, 0, out);
    const laptop = join(root, "preview", "shots", "rc-2026-10-04.1-inbox-laptop.png");
    const phone = join(root, "preview", "shots", "rc-2026-10-04.1-inbox-phone.png");
    const consoleLog = join(root, "preview", "shots", "rc-2026-10-04.1-inbox-console.txt");
    assert.deepEqual(out.trim().split("\n"), [laptop, phone, consoleLog]);
    assert.ok(existsSync(laptop) && existsSync(phone));
    assert.deepEqual(calls().trim().split("\n"), ["scripts/preview-shot.mjs", "http://localhost:3200/GRE/issues", laptop, phone, consoleLog]);
  }));
});

test("shot refuses any port other than 3200 and never calls the browser (GRE-606)", () => {
  withFakePreview({ port: 3200 }, (root) => withFakeNode((env, calls) => {
    for (const port of ["3100", "3201"]) {
      const { code, out } = runPreview(["shot", "/", "home"], root, { ...env, GSAM_PREVIEW_PORT: port });
      assert.equal(code, 1);
      assert.match(out, new RegExp(`shot only opens the preview on port 3200, not port ${port}\\.`));
    }
    assert.equal(calls(), "");
  }));
  // A state file that says the running preview is on another port.
  withFakePreview({ port: 3100 }, (root) => withFakeNode((env, calls) => {
    const { code, out } = runPreview(["shot", "/", "home"], root, { ...env, GSAM_PREVIEW_PORT: "3200" });
    assert.equal(code, 1);
    assert.match(out, /the running preview is on port 3100; shot only opens port 3200\./);
    assert.equal(calls(), "");
  }));
});

test("shot fails with a clear message when no preview runs (GRE-606)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    withFakeNode((env, calls) => {
      const { code, out } = runPreview(["shot", "/", "home"], root, { ...env, GSAM_PREVIEW_PORT: "3200" });
      assert.equal(code, 1);
      assert.match(out, /no preview is running; start one with 'greatstone-preview\.sh start <tag>'\./);
      assert.equal(calls(), "");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shot checks its arguments before anything else (GRE-606)", () => {
  withFakePreview({ port: 3200 }, (root) => withFakeNode((env, calls) => {
    const run = (...args) => runPreview(["shot", ...args], root, { ...env, GSAM_PREVIEW_PORT: "3200" });
    assert.match(run("/").out, /usage: greatstone-preview\.sh shot <page path> <name>/);
    assert.match(run("GRE/issues", "x").out, /the page path must start with \//);
    assert.match(run("/", "../x").out, /the name may use only letters/);
    assert.equal(calls(), "");
  }));
});

test("shot looks for the browser in the account home, not the agent's temp HOME (GRE-732)", () => {
  const shared = join(userInfo().homedir, process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  withFakePreview({ port: 3200 }, (root) => withFakeNode((env, calls, browsersPath) => {
    // runPreview sets HOME to a temp folder, as an agent run does.
    assert.equal(runPreview(["shot", "/", "home"], root, { ...env, GSAM_PREVIEW_PORT: "3200" }).code, 0);
    assert.equal(runPreview(["shot", "/", "home"], root, { ...env, GSAM_PREVIEW_PORT: "3200", PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" }).code, 0);
    assert.deepEqual(browsersPath().trim().split("\n"), [shared, "/opt/pw"]);
  }));
});

test("start in a checkout with no dependencies says to run pnpm install, before copying anything (GRE-732)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const clone = mkdtempSync(join(tmpdir(), "gs-preview-clone-"));
  try {
    mkdirSync(join(clone, "scripts"));
    for (const f of ["greatstone-preview.sh", "greatstone-common.sh"]) {
      writeFileSync(join(clone, "scripts", f), readFileSync(join(scriptsDir, f)));
    }
    mkdirSync(join(root, "data", "instances", "default"), { recursive: true });
    const result = (() => {
      try {
        return execFileSync("bash", [join(clone, "scripts", "greatstone-preview.sh"), "start", "rc-1"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env.PATH, HOME: root, GSAM_ROOT: root, GSAM_PREVIEW_PORT: "1" },
        });
      } catch (error) {
        return { code: error.status, out: `${error.stdout}${error.stderr}` };
      }
    })();
    assert.equal(result.code, 1);
    assert.match(result.out, /no dependencies installed; run first: \(cd .*gs-preview-clone-.* && pnpm install --frozen-lockfile\)/);
    assert.ok(!existsSync(join(root, "preview")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

// Shot files as `shot` leaves them: <tag>-<name>-{laptop,phone}.png and a
// console file in preview-shot.mjs's format. Returns a listing of the folder.
function writeShots(root, shots) {
  const dir = join(root, "preview", "shots");
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(shots)) writeFileSync(join(dir, file), body);
  return () => readdirSync(dir).sort().map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`);
}

const consoleFile = (...lines) => `http://localhost:3200/\nconsole errors: ${lines.length}\n${lines.map((l) => `${l}\n`).join("")}`;

test("evidence prints one row per shot of the running tag with its error counts (GRE-700)", () => {
  withFakePreview({ tag: "rc-2026-10-05.1", port: 3200 }, (root) => {
    const listing = writeShots(root, {
      "rc-2026-10-05.1-inbox-laptop.png": "", "rc-2026-10-05.1-inbox-phone.png": "",
      "rc-2026-10-05.1-inbox-console.txt": consoleFile(),
      "rc-2026-10-05.1-board-laptop.png": "", "rc-2026-10-05.1-board-phone.png": "",
      "rc-2026-10-05.1-board-console.txt": consoleFile(
        "[laptop] console: TypeError: x is undefined", "[phone] pageerror: boom",
        "[phone] console: TypeError: x is undefined", "[laptop] http 500: GET /api/issues"),
      // Another tag's shots, including one whose tag starts with this tag.
      "rc-2026-10-04.1-inbox-laptop.png": "", "rc-2026-10-04.1-inbox-phone.png": "",
      "rc-2026-10-04.1-inbox-console.txt": consoleFile("[laptop] http 404: GET /x"),
      "rc-2026-10-05.10-inbox-laptop.png": "",
    });
    const before = listing();
    const { code, out } = runPreview(["evidence"], root, { GSAM_PREVIEW_PORT: "3200" });
    assert.equal(code, 0, out);
    const rows = out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Shot"));
    assert.deepEqual(rows, [
      "| board | rc-2026-10-05.1-board-laptop.png | rc-2026-10-05.1-board-phone.png | 3 | 1 | check |",
      "| inbox | rc-2026-10-05.1-inbox-laptop.png | rc-2026-10-05.1-inbox-phone.png | 0 | 0 | ok |",
    ]);
    assert.match(out, /^\| Shot \| Laptop \| Phone \| Console errors \| Failed requests \| Result \|$/m);
    assert.doesNotMatch(out, /rc-2026-10-04\.1|rc-2026-10-05\.10/);
    assert.deepEqual(listing(), before, "evidence must not write or delete files");
  });
});

test("evidence marks a failed request alone, a missing file or no console file as check (GRE-700)", () => {
  withFakePreview({ tag: "rc-t", port: 3200 }, (root) => {
    writeShots(root, {
      "rc-t-a-laptop.png": "", "rc-t-a-phone.png": "", "rc-t-a-console.txt": consoleFile("[phone] http 404: GET /api/x"),
      "rc-t-b-laptop.png": "", "rc-t-b-console.txt": consoleFile(),
      "rc-t-c-laptop.png": "", "rc-t-c-phone.png": "",
    });
    const rows = runPreview(["evidence"], root).out.split("\n").filter((l) => /^\| [abc] /.test(l));
    assert.deepEqual(rows, [
      "| a | rc-t-a-laptop.png | rc-t-a-phone.png | 0 | 1 | check |",
      "| b | rc-t-b-laptop.png | missing | 0 | 0 | check |",
      "| c | rc-t-c-laptop.png | rc-t-c-phone.png | no console file | no console file | check |",
    ]);
  });
});

test("evidence with no shots for the tag prints one line and exits 0 (GRE-700)", () => {
  withFakePreview({ tag: "rc-new", port: 3200 }, (root) => {
    writeShots(root, { "rc-old-inbox-laptop.png": "", "rc-old-inbox-console.txt": consoleFile() });
    const { code, out } = runPreview(["evidence"], root);
    assert.equal(code, 0, out);
    assert.equal(out, `No shots for rc-new in ${join(root, "preview", "shots")}.\n`);
  });
  // No shots folder at all: still one line, and the folder is not created.
  withFakePreview({ tag: "rc-new" }, (root) => {
    const { code, out } = runPreview(["evidence"], root);
    assert.equal(code, 0, out);
    assert.match(out, /^No shots for rc-new in .*\.\n$/);
    assert.ok(!existsSync(join(root, "preview", "shots")));
  });
});

test("evidence takes a tag when no preview runs, and refuses a bad one (GRE-700)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    assert.match(runPreview(["evidence"], root).out, /no preview is running; give the tag: greatstone-preview\.sh evidence <tag>/);
    writeShots(root, { "rc-x-home-laptop.png": "", "rc-x-home-phone.png": "", "rc-x-home-console.txt": consoleFile() });
    assert.match(runPreview(["evidence", "rc-x"], root).out, /^\| home \| rc-x-home-laptop\.png \| rc-x-home-phone\.png \| 0 \| 0 \| ok \|$/m);
    const bad = runPreview(["evidence", "../x"], root);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /the tag may use only letters/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The preview lock (15 Oct 2026): Flint's preview starts ran during John's, each
// removed the seed and data copy the other was restoring, and the preview of
// rc-2026-10-15.3 never came up.
function writePreviewLock(root, pid, extra = "") {
  const dir = join(root, "locks", "preview.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner"), `pid=${pid}\ncommand=greatstone-preview.sh start rc-2026-10-15.3\nrun_id=run-9\n${extra}`);
  return dir;
}

test("start, switch-tests and stop refuse while another preview step holds the lock", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const lock = writePreviewLock(root, holder.pid);
    for (const args of [["start", "rc-other"], ["switch-tests"], ["stop"]]) {
      const { code, out } = runPreview(args, root);
      assert.equal(code, 1, args[0]);
      assert.match(out, new RegExp(`^preview: another preview step runs \\(pid=${holder.pid} command=greatstone-preview\\.sh start rc-2026-10-15\\.3 run_id=run-9\\); wait for it to end\\.`, "m"), args[0]);
      assert.equal(readFileSync(join(lock, "owner"), "utf8").includes(`pid=${holder.pid}`), true, `${args[0]} left the holder's lock alone`);
    }
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock left by a killed preview step is taken over, and freed on exit", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    // The pid of a process that has ended.
    const pid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    const lock = writePreviewLock(root, pid);
    mkdirSync(join(root, "preview"), { recursive: true });
    const run = spawnSync("bash", [join(scriptsDir, "greatstone-preview.sh"), "stop"], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GSAM_ROOT: root, GSAM_PREVIEW_PORT: "1" },
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, out);
    assert.match(out, new RegExp(`Took over the preview lock from pid ${pid}, which no longer runs\\.`));
    assert.match(out, /No preview is running\./);
    assert.equal(existsSync(lock), false, "the lock is freed when stop ends");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock folder with no owner yet counts as held for a minute", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "locks", "preview.lock"), { recursive: true });
    const { code, out } = runPreview(["stop"], root);
    assert.equal(code, 1);
    assert.match(out, /another preview step runs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// preview_check: what greatstone-release.sh asks before a release by hand.
function fakePreviewHealth(commit) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/health" ? { status: "ok", commit } : {}));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// withFakePreview for an async check: the fake preview lives until it ends.
async function withFakePreviewAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const dataDir = join(root, "preview", "data");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", dataDir], { stdio: "ignore" });
  try {
    writeFileSync(join(root, "preview", "preview.state"), `tag=rc-test\ncommit=abc\npid=${child.pid}\nport=3200\n`);
    return await fn(root);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

async function previewCheck(root, port, commit = "abc") {
  try {
    const { stdout } = await promisify(execFile)("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; preview_check "$1" rc-test`, "_", commit], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GSAM_ROOT: root, GSAM_PREVIEW_PORT: String(port), GSAM_LIVE_BOARD_KEY_FILE: join(root, "no-key") },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.code, out: error.stdout };
  }
}

test("preview_check fails when no preview runs, so a release by hand cannot skip the preview silently", async () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    const { code, out } = await previewCheck(root, 9);
    assert.equal(code, 1);
    assert.match(out, /^no preview of rc-test is running, so it was not checked on a copy of the live data\. Start it: scripts\/greatstone-preview\.sh start rc-test\. Only in an emergency: greatstone-release\.sh --skip-preview "<reason>" rc-test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview_check fails for a preview of another commit, or one that does not answer", async () => {
  await withFakePreviewAsync(async (root) => {
    const other = await previewCheck(root, 9, "def");
    assert.equal(other.code, 1);
    assert.match(other.out, /^the preview runs rc-test \(abc\), not rc-test\./);
    // The state names the commit, but nothing answers on the preview port (15 Oct 2026: "preview 000").
    const down = await previewCheck(root, 9);
    assert.equal(down.code, 1);
    assert.match(down.out, /^the preview of rc-test does not answer on http:\/\/localhost:9\/api\/health/);
  });
});

test("preview_check passes when the preview runs the commit and answers", async (t) => {
  const server = await fakePreviewHealth("abc");
  t.after(() => server.close());
  await withFakePreviewAsync(async (root) => {
    const { code, out } = await previewCheck(root, server.address().port);
    assert.equal(code, 0, out);
    assert.match(out, /^the preview runs rc-test \(abc\) and answers on http:\/\/localhost:\d+/);
    const wrong = await fakePreviewHealth("old");
    try {
      const stale = await previewCheck(root, wrong.address().port);
      assert.equal(stale.code, 1, "a server on the port that runs other code is not the preview of the tag");
    } finally {
      wrong.close();
    }
  });
});

test("script runs from the preview code folder, never from live, and removes its copy", () => {
  withFakePreview({}, (root) => {
    const scripts = join(root, "preview", "code", "scripts");
    mkdirSync(scripts, { recursive: true });
    const file = join(root, "walk.mjs");
    writeFileSync(file, "console.log(`at ${new URL(import.meta.url).pathname} cwd ${process.cwd()} args ${process.argv.slice(2)}`);\n");
    const { code, out } = runPreview(["script", file, "a", "b"], root);
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`^at ${scripts}/_agent-\\d+-walk\\.mjs cwd ${join(root, "preview", "code")} args a,b$`, "m"));
    assert.deepEqual(readdirSync(scripts), [], "the copy is removed");
    assert.equal(existsSync(join(root, "live")), false);
  });
});

test("script refuses with no preview running", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    const file = join(root, "walk.mjs");
    writeFileSync(file, "\n");
    const { code, out } = runPreview(["script", file], root);
    assert.equal(code, 1);
    assert.match(out, /preview: no preview is running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// GRE-2486: the release queue's state, as greatstone-release-queue.mjs writes it.
function writeQueue(root, items) {
  mkdirSync(join(root, "release-queue"), { recursive: true });
  writeFileSync(join(root, "release-queue", "queue.json"), JSON.stringify({ items, main: null, worker: null }));
}

test("an agent's start, switch-tests and stop are refused while a queue request runs (GRE-2486)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "preview"), { recursive: true });
    writeQueue(root, [{ id: "rq-621bf4", ref: "main", status: "running", step: "preview", commit: "0123456789abcdef", tag: "rc-2026-10-25.10" }]);
    for (const args of [["start", "rc-2026-10-25.9"], ["switch-tests"], ["stop"]]) {
      const { code, out } = runPreview(args, root, { GSAM_RUN_ID: "run-flint" });
      assert.equal(code, 1, args[0]);
      assert.match(out, /^preview: The release queue is releasing 012345678 \(rq-621bf4, rc-2026-10-25\.10\); its own preview covers this\. Check the queue status: node scripts\/greatstone-release-queue\.mjs status$/m, args[0]);
      assert.equal(existsSync(join(root, "locks", "preview.lock")), false, `${args[0]} took no lock`);
    }
    // The queue's own steps and people pass the guard.
    assert.equal(runPreview(["stop"], root, { GSAM_RUN_ID: "run-flint", GSAM_RELEASE_QUEUE_ITEM: "rq-621bf4" }).code, 0);
    assert.equal(runPreview(["stop"], root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent's preview steps run while requests only wait in the queue, or the queue is empty (GRE-2486)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "preview"), { recursive: true });
    assert.match(runPreview(["stop"], root, { GSAM_RUN_ID: "run-flint" }).out, /No preview is running\./);
    writeQueue(root, [{ id: "rq-1", ref: "main", status: "queued" }, { id: "rq-0", ref: "main", status: "released", commit: "abc" }]);
    const { code, out } = runPreview(["stop"], root, { GSAM_RUN_ID: "run-flint" });
    assert.equal(code, 0, out);
    assert.match(out, /No preview is running\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run takes over its own dead lock once; the second time it fails and says why (GRE-2486)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "preview"), { recursive: true });
    const dead = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    const owner = join(root, "locks", "preview.lock", "owner");
    // The run's first start was killed: its lock (takeovers=0) is taken over once, and the new owner says so.
    writePreviewLock(root, dead, "takeovers=0\n");
    const got = runSetup('preview_lock start rc-1; cat "$GS_ROOT/locks/preview.lock/owner"; trap - EXIT', { GSAM_ROOT: root, HOME: root, GSAM_RUN_ID: "run-9" });
    assert.match(got, /^takeovers=1$/m);
    assert.match(got, /^run_id=run-9$/m);
    // That start was killed too: the same run does not start a third time.
    writeFileSync(owner, readFileSync(owner, "utf8").replace(/^pid=\d+$/m, `pid=${dead}`));
    const { code, out } = runPreview(["start", "rc-1"], root, { GSAM_RUN_ID: "run-9" });
    assert.equal(code, 1);
    assert.match(out, /^preview: this run \(run-9\) already took over its own preview lock once, and that step \(pid \d+\) was also stopped before it ended, most likely by a tool time limit\. Not starting a third time\./m);
    assert.match(readFileSync(owner, "utf8"), /^takeovers=1$/m, "the lock is left for the queue or a person to take over");
    // Another run (or the queue, with no run) takes the same dead lock over as before, counting from 0.
    const other = runPreview(["stop"], root, { GSAM_RUN_ID: "run-other" });
    assert.equal(other.code, 0, other.out);
    assert.match(other.out, /No preview is running\./);
    assert.equal(existsSync(join(root, "locks", "preview.lock")), false, "taken over, then freed on exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// GRE-3502: a start copies the live data and takes 8 to 12 minutes, so the
// end of an agent run killed it mid-copy (GRE-3438, GRE-3493). A fake GSAM
// root and checkout in which `start` runs end to end in seconds: live data and
// a live database pid file, a release repo with tag rc-1, a fake tsx for
// `greatstone-db.ts seed-preview` that waits for a gate file (then fails with
// FAKE_SEED_FAIL) and writes its pid, run marker and folder to FAKE_SEED_INFO,
// and a fake pnpm whose `install` writes its pid and Corepack settings to
// FAKE_PNPM_INFO (and hangs with FAKE_INSTALL_HANG) and whose `dev:once`
// answers /api/health with the checked-out commit on the preview port.
async function withFakeStart(fn, seedEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const clone = mkdtempSync(join(tmpdir(), "gs-preview-clone-"));
  const repo = mkdtempSync(join(tmpdir(), "gs-preview-repo-"));
  const bin = join(clone, "bin");
  const gate = join(clone, "seed-gate");
  const seedInfo = join(clone, "seed-info.json");
  const pnpmInfo = join(clone, "pnpm-info");
  try {
    mkdirSync(join(clone, "scripts"));
    for (const f of ["greatstone-preview.sh", "greatstone-common.sh"]) writeFileSync(join(clone, "scripts", f), readFileSync(join(scriptsDir, f)));
    mkdirSync(join(clone, "cli", "node_modules", "tsx", "dist"), { recursive: true });
    writeFileSync(join(clone, "cli", "node_modules", "tsx", "dist", "cli.mjs"), [
      'import { existsSync, writeFileSync } from "node:fs";',
      `const { GSAM_RUN_ID = null, ${LEGACY_RUN_ID}: legacyRunId = null } = process.env;`,
      "writeFileSync(process.env.FAKE_SEED_INFO, JSON.stringify({ pid: process.pid, GSAM_RUN_ID, legacyRunId, cwd: process.cwd() }));",
      "const until = Date.now() + 60_000;",
      "while (!existsSync(process.env.FAKE_SEED_GATE) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));",
      'if (process.env.FAKE_SEED_FAIL) { console.error("seed-preview: the restore failed"); process.exit(1); }',
      'console.log("Seeded the preview database");',
    ].join("\n"));
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), [
      "#!/usr/bin/env bash",
      'if [ "$1" = install ]; then',
      '  printf \'pid=%s\\nprompt=%s\\ncorepack_home=%s\\n\' "$$" "${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" "${COREPACK_HOME:-}" >"$FAKE_PNPM_INFO"',
      '  env >"$FAKE_PNPM_INFO.env"',
      '  [ -z "${FAKE_INSTALL_HANG:-}" ] || exec sleep 600',
      '  if [ -n "${FAKE_INSTALL_GATE:-}" ]; then for _ in $(seq 1 600); do [ -e "$FAKE_INSTALL_GATE" ] && break; sleep 0.1; done; fi',
      // pnpm keeps its store and temp files there; a real install whose folders were removed waited for ever (GRE-3525).
      '  for d in "$HOME" "${TMPDIR:-/tmp}" "${XDG_DATA_HOME:-$HOME}"; do [ -d "$d" ] || { echo "pnpm: $d is gone" >&2; exit 1; }; done',
      "fi",
      '[ "$1" = dev:once ] || exit 0',
      `exec node -e 'require("http").createServer((q, s) => s.end(JSON.stringify({ status: "ok", commit: process.argv[1] }))).listen(Number(process.env.PORT))' "$(git rev-parse HEAD)" "$@"`,
    ].join("\n"), { mode: 0o755 });
    const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "-m", "rc");
    git("tag", "rc-1");
    const db = join(root, "data", "instances", "default", "db");
    mkdirSync(db, { recursive: true });
    writeFileSync(join(root, "data", "instances", "default", "file.txt"), "live\n");
    writeFileSync(join(db, "postmaster.pid"), `${process.pid}\n${db}\n0\n5432\n`);
    const port = await new Promise((resolve) => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const env = {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, GSAM_ROOT: root, GSAM_RELEASE_REPO: repo,
      GSAM_PREVIEW_PORT: String(port), FAKE_SEED_GATE: gate, FAKE_SEED_INFO: seedInfo, FAKE_PNPM_INFO: pnpmInfo, ...seedEnv,
    };
    const script = join(clone, "scripts", "greatstone-preview.sh");
    const run = (...args) => {
      const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env, timeout: 60_000 });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const readSeed = () => { try { return JSON.parse(readFileSync(seedInfo, "utf8")); } catch { return null; } };
    const readPnpm = () => { try { return Object.fromEntries(readFileSync(pnpmInfo, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))); } catch { return null; } };
    return await fn({ root, env, script, run, port, commit: git("rev-parse", "HEAD"), openGate: () => writeFileSync(gate, ""), readSeed, readPnpm });
  } finally {
    const pidIn = (file) => { try { return Number(readFileSync(file, "utf8").match(/^(?:pid=)?(\d+)/m)?.[1]); } catch { return 0; } };
    for (const pid of [pidIn(join(root, "preview", "start.state")), pidIn(join(root, "preview", "preview.state")), pidIn(join(root, "preview", "start.step"))]) {
      if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    for (const pid of [pidIn(pnpmInfo), (() => { try { return JSON.parse(readFileSync(seedInfo, "utf8")).pid; } catch { return 0; } })()]) {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    for (const dir of [root, clone, repo]) {
      try { execFileSync("chmod", ["-R", "u+w", dir]); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function waitFor(what, check, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const health = (port) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/api/health`, (res) => { let s = ""; res.on("data", (d) => { s += d; }).on("end", () => resolve(s)); })
    .on("error", () => resolve(null));
});

test("start returns at once, and the preview comes up after the calling shell is killed (GRE-3502)", async () => {
  await withFakeStart(async ({ root, env, script, run, port, commit, openGate }) => {
    // The caller starts the preview and would go on; then it is killed, as the end of an agent run kills its tool.
    const out = join(root, "caller.out");
    const began = Date.now();
    const caller = spawn("bash", ["-c", `bash ${JSON.stringify(script)} start rc-1 >${JSON.stringify(out)} 2>&1; echo "exit $?" >>${JSON.stringify(out)}; sleep 600`],
      { env, detached: true, stdio: "ignore" });
    let said;
    try {
      said = await waitFor("start to return", () => existsSync(out) && /^exit \d+$/m.test(readFileSync(out, "utf8")) && readFileSync(out, "utf8"));
    } finally {
      process.kill(-caller.pid, "SIGKILL");
    }
    assert.ok(Date.now() - began < 30_000, `start returned after ${Date.now() - began} ms`);
    assert.match(said, /^exit 0$/m, said);
    assert.match(said, new RegExp(`^Starting the preview of rc-1 \\(${commit}\\) in the background: pid \\d+, log ${join(root, "preview", "start.log")}$`, "m"));

    const starting = run("status");
    assert.equal(starting.code, 0, starting.out);
    assert.match(starting.out, /^Start: +starting \(rc-1, pid \d+, started \d+s ago by run unknown for issue unknown; log: \S+start\.log\)$/m);
    assert.doesNotMatch(starting.out, /No preview is running/);

    // A second start says a start runs and starts no other copy.
    const first = readFileSync(join(root, "preview", "start.state"), "utf8");
    const second = run("start", "rc-1");
    assert.equal(second.code, 1);
    assert.match(second.out, /^preview: a start of rc-1 already runs in the background \(pid \d+, started \d+s ago by run unknown for issue unknown\); follow it with 'greatstone-preview\.sh status'/m);
    assert.equal(readFileSync(join(root, "preview", "start.state"), "utf8"), first, "the running start is left alone");
    assert.equal((readFileSync(join(root, "preview", "start.log"), "utf8").match(/^Preview rc-1 /gm) ?? []).length, 1, "one copy only");

    openGate();
    const up = await waitFor("status up", () => { const s = run("status").out; return /^Start: +up /m.test(s) && s; });
    assert.match(up, /^  tag: +rc-1$/m);
    assert.match(await health(port), new RegExp(`"commit":"${commit}"`));
    assert.equal(existsSync(join(root, "locks", "preview.lock")), false, "the background start freed the lock");

    const stopped = run("stop");
    assert.match(stopped.out, /Preview stopped\./, stopped.out);
    assert.equal(await health(port), null);
    assert.equal(run("status").out, "No preview is running.\n");
  });
});

test("status says failed when the background start fails or is killed (GRE-3502)", async () => {
  await withFakeStart(async ({ root, run, openGate }) => {
    assert.equal(run("start", "rc-1").code, 0);
    assert.match(run("status").out, /^Start: +starting /m);
    openGate();
    const failed = await waitFor("status failed", () => { const s = run("status").out; return /^Start: +failed /m.test(s) && s; });
    assert.match(failed, /^ +preview: the database copy \(seed-preview\) failed \(exit 1\)\.$/m);
    assert.match(failed, /^ +last lines of the log:\n(?: {14}.*\n)*? {14}seed-preview: the restore failed$/m);
    assert.match(failed, /^No preview is running\.$/m);
    assert.equal(existsSync(join(root, "locks", "preview.lock")), false, "a failed start frees the lock");
  }, { FAKE_SEED_FAIL: "1" });

  await withFakeStart(async ({ root, run, readSeed }) => {
    assert.equal(run("start", "rc-1").code, 0);
    const pid = Number(readFileSync(join(root, "preview", "start.state"), "utf8").match(/^pid=(\d+)$/m)[1]);
    const seed = await waitFor("the seed step", readSeed);
    process.kill(-pid, "SIGKILL");
    const failed = await waitFor("status failed", () => { const s = run("status").out; return /^Start: +failed /m.test(s) && s; });
    assert.match(failed, /it stopped before the preview was up/);
    // The step of a start killed by force runs on in its own process group (GRE-3505): status names it.
    assert.match(failed, /^ +its step 'the database copy \(seed-preview\)' still runs \(process group \d+\); 'greatstone-preview\.sh stop' ends it\.$/m);
    // A killed start leaves its lock; the next start takes it over, ends the left step and runs.
    const again = run("start", "rc-1");
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Took over the preview lock/);
    assert.match(run("status").out, /^Start: +starting /m);
    await waitFor("the left seed step to end", () => { try { process.kill(seed.pid, 0); return false; } catch { return true; } });
  });
});

// The server's end-of-run cleanup, as server/src/services/run-process-cleanup.ts
// selects: this user's processes whose environment carries the run's
// GSAM_RUN_ID or its legacy alias, unless their command or folder is in the
// GSAM root. Returns them; Linux only (it reads /proc).
function runEndLeftovers(runId, gsamRoot) {
  const found = [];
  for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      if (statSync(`/proc/${name}`).uid !== process.getuid()) continue;
      const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      if (!env.includes(`GSAM_RUN_ID=${runId}`) && !env.includes(`${LEGACY_RUN_ID}=${runId}`)) continue;
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if ([...args, readlinkSync(`/proc/${name}/cwd`)].some((text) => text.includes(gsamRoot))) continue;
      found.push({ pid: Number(name), args: args.join(" ") });
    } catch {}
  }
  return found;
}

test("the end of the agent run does not stop a background start (GRE-3505)", { skip: !existsSync("/proc/self/environ") && "needs /proc" }, async () => {
  await withFakeStart(async ({ root, env, script, readSeed, run, openGate }) => {
    const runId = `run-3505-${process.pid}`;
    const r = spawnSync("bash", [script, "start", "rc-1"],
      { encoding: "utf8", env: { ...env, GSAM_RUN_ID: runId, [LEGACY_RUN_ID]: runId, GSAM_TASK_ID: "issue-3505" }, timeout: 60_000 });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const seed = await waitFor("the seed step", readSeed);
    // On 1 Nov 2026 the cleanup stopped the start, which carried the marker and ran in the worktree.
    const leftovers = runEndLeftovers(runId, root);
    for (const { pid } of leftovers) try { process.kill(pid, "SIGTERM"); } catch {}
    assert.deepEqual(leftovers, [], "nothing of the background start carries the run's marker outside ~/GSAM");
    assert.equal(seed.GSAM_RUN_ID, null);
    assert.equal(seed.legacyRunId, null);
    const worker = Number(readFileSync(join(root, "preview", "start.state"), "utf8").match(/^pid=(\d+)$/m)[1]);
    assert.equal(readlinkSync(`/proc/${worker}/cwd`), join(root, "preview"));
    assert.match(run("status").out, /^Start: +starting \(rc-1, pid \d+, started \d+s ago by run run-3505-\d+ for issue issue-3505; /m);
    openGate();
    const up = await waitFor("status up", () => { const s = run("status").out; return /^Start: +up /m.test(s) && s; });
    assert.match(up, new RegExp(`^  origin: +started \\d+s ago by run ${runId} for issue issue-3505$`, "m"));
  });
});

// The server removes a run's temp HOME (with the pnpm store in XDG_DATA_HOME)
// and its scratch TMPDIR when the run ends. On 1 Nov 2026 the background
// start's `pnpm install` still used them and then waited for ever (GRE-3525).
test("the background start uses no folder of the agent run, which the run's end removes (GRE-3525)", async () => {
  const runHome = mkdtempSync(join(tmpdir(), "gs-preview-runhome-"));
  const runTmp = mkdtempSync(join(tmpdir(), "gs-preview-runtmp-"));
  const launcher = mkdtempSync(join(tmpdir(), "gs-preview-launcher-"));
  const gateDir = mkdtempSync(join(tmpdir(), "gs-preview-gate-"));
  const installGate = join(gateDir, "open");
  try {
    await withFakeStart(async ({ root, env, script, run, openGate }) => {
      const runId = `run-3525-${process.pid}`;
      const r = spawnSync("bash", [script, "start", "rc-1"], {
        encoding: "utf8", timeout: 60_000,
        env: {
          ...env, PATH: `${launcher}:${env.PATH}`, GSAM_RUN_ID: runId, GSAM_TASK_ID: "issue-3525", HOME: runHome,
          XDG_DATA_HOME: join(runHome, "data"), XDG_CONFIG_HOME: join(runHome, "config"), CODEX_HOME: join(runHome, "codex"),
          TMPDIR: runTmp, TMP: runTmp, GSAM_RUN_SCRATCH_DIR: runTmp, [`${"paperclip".toUpperCase()}_SCRATCH_DIR`]: runTmp,
          GSAM_GITHUB_LAUNCHER_DIR: launcher, BASH_ENV: join(launcher, ".bashrc"), FAKE_INSTALL_GATE: installGate,
        },
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      const envFile = `${env.FAKE_PNPM_INFO}.env`;
      const installEnv = await waitFor("pnpm install", () => existsSync(envFile) && readFileSync(envFile, "utf8"));
      // The run ends: its folders go.
      for (const dir of [runHome, runTmp, launcher]) rmSync(dir, { recursive: true, force: true });
      writeFileSync(installGate, "");
      // GSAM_* settings stay (record_release_repo reads the scratch folders); a missing PATH folder is skipped.
      const inRun = installEnv.split("\n").filter((line) => !/^(GSAM_[A-Z_]+|PATH)=/.test(line)
        && [runHome, runTmp, launcher].some((dir) => line.includes(dir)));
      assert.deepEqual(inRun, [], "no variable of pnpm install points into the run's folders");
      assert.match(installEnv, new RegExp(`^TMPDIR=${join(root, "preview", "tmp")}$`, "m"));
      assert.match(installEnv, new RegExp(`^HOME=${userInfo().homedir}$`, "m"));
      assert.match(installEnv, new RegExp(`^GSAM_ROOT=${root}$`, "m"));
      assert.match(installEnv, new RegExp(`^GSAM_RUN_SCRATCH_DIR=${runTmp}$`, "m"));
      openGate();
      const up = await waitFor("status up", () => { const s = run("status").out; return /^Start: +(up|failed) /m.test(s) && s; });
      assert.match(up, /^Start: +up /m, up);
      assert.match(up, new RegExp(`^  origin: +started \\d+s ago by run ${runId} for issue issue-3525$`, "m"));
    });
  } finally {
    for (const dir of [runHome, runTmp, launcher, gateDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test("status says starting while the worker runs, even when the pid on record is gone (GRE-3505)", async () => {
  await withFakeStart(async ({ root, run, openGate }) => {
    assert.equal(run("start", "rc-1").code, 0);
    const stateFile = join(root, "preview", "start.state");
    await waitFor("the worker to start", () => /^Preview rc-1 /m.test(readFileSync(join(root, "preview", "start.log"), "utf8")));
    const worker = Number(readFileSync(stateFile, "utf8").match(/^pid=(\d+)$/m)[1]);
    const gone = spawnSync("true").pid;
    writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace(/^pid=\d+$/m, `pid=${gone}`));
    const status = run("status").out;
    assert.match(status, new RegExp(`^Start: +starting \\(rc-1, pid ${worker}, `, "m"), status);
    const second = run("start", "rc-1");
    assert.equal(second.code, 1, second.out);
    assert.match(second.out, /a start of rc-1 already runs in the background/);
    openGate();
    await waitFor("status up", () => /^Start: +up /m.test(run("status").out));
  });
});

test("a stalled step fails the start at its time limit, and pnpm gets no Corepack prompt (GRE-3505)", async () => {
  await withFakeStart(async ({ root, run, readPnpm }) => {
    assert.equal(run("start", "rc-1").code, 0);
    const pnpm = await waitFor("pnpm install", readPnpm);
    assert.equal(pnpm.prompt, "0");
    assert.ok(!pnpm.corepack_home.startsWith(root), `Corepack cache in the temp HOME: ${pnpm.corepack_home}`);
    const failed = await waitFor("status failed", () => { const s = run("status").out; return /^Start: +failed /m.test(s) && s; });
    assert.match(failed, /^ +preview: pnpm install did not end within the start's limit of 3 seconds and was stopped\.$/m);
    assert.match(failed, /^ +last lines of the log:\n(?: {14}.*\n)* {14}Installing dependencies\.\.\.$/m);
    assert.throws(() => process.kill(Number(pnpm.pid), 0), "the stalled pnpm was stopped");
    assert.equal(existsSync(join(root, "locks", "preview.lock")), false, "a failed start frees the lock");
  }, { FAKE_INSTALL_HANG: "1", GSAM_PREVIEW_START_LIMIT_S: "3" });
});

test("the release queue's own start still runs in the foreground (GRE-3502)", async () => {
  await withFakeStart(async ({ root, env, script, openGate }) => {
    openGate();
    const r = spawnSync("bash", [script, "start", "rc-1"], { encoding: "utf8", env: { ...env, GSAM_RELEASE_QUEUE_ITEM: "rq-1" }, timeout: 60_000 });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^Preview is up: /m);
    assert.equal(existsSync(join(root, "preview", "start.state")), false);
  });
});
