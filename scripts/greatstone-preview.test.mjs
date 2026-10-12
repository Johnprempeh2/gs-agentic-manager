// Tests for the environment scripts/greatstone-preview.sh gives the preview
// server. Only the variable setup is run: no preview is started, and nothing
// under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
