// Tests for the environment scripts/greatstone-preview.sh gives the preview
// server. Only the variable setup is run: no preview is started, and nothing
// under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import http from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

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
