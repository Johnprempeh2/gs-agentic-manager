import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addedLines, checkDiff, hashName, loadAllow, loadBlocklist } from "./check-repo-hygiene.mjs";

const SCRIPT = fileURLToPath(new URL("./check-repo-hygiene.mjs", import.meta.url));

// Planted values are built at run time so this file holds no key or client name itself
// (the check runs on its own pull request).
const FAKE_GITHUB_TOKEN = "gh" + "p_" + "Zq8rT2vLm4Xk9Wn3Bc7Hy5Jd1Fs6Gp0Qa2Re";
const FAKE_AWS_KEY = "AK" + "IA" + "Q7RZ4M2KX9TB3VWD";
const CLIENT_NAME = "Inda" + "go";

function diffAdding(file, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,0 +11,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

const none = { allow: [] };

test("a planted fake GitHub token in an added line fails, redacted", () => {
  const findings = checkDiff(diffAdding("server/src/config.ts", [`const token = "${FAKE_GITHUB_TOKEN}";`]), none);
  assert.deepEqual(findings.map((f) => [f.path, f.line, f.rule]), [["server/src/config.ts", 11, "github-token"]]);
  assert.ok(!findings[0].match.includes(FAKE_GITHUB_TOKEN.slice(4)), "the token is not printed");
});

test("a planted AWS key and a private key block fail", () => {
  const findings = checkDiff(diffAdding("deploy/env.sh", [`export AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}`, "-----BEGIN RSA PRIVATE" + " KEY-----"]), none);
  assert.deepEqual(findings.map((f) => f.rule), ["aws-access-key", "private-key"]);
});

test("a planted blocklisted client name fails, in any case and inside camelCase", () => {
  const lines = [`title: "Sign the ${CLIENT_NAME} brief",`, `const ${CLIENT_NAME.toLowerCase()}Tasks = [];`, `// ${CLIENT_NAME.toUpperCase()} pack`];
  const findings = checkDiff(diffAdding("ui/src/lib/x.test.ts", lines), none);
  assert.deepEqual(findings.map((f) => [f.line, f.rule]), [[11, "name"], [12, "name"], [13, "name"]]);
  assert.ok(findings.every((f) => !f.match.toLowerCase().includes(CLIENT_NAME.toLowerCase())), "the name is not printed in full");
});

test("multi-word names match as a phrase, not word by word", () => {
  const blocklist = new Set([hashName("Kestrel Works")]);
  assert.equal(checkDiff(diffAdding("a.ts", ["Kestrel  works retainer"]), { blocklist, allow: [] }).length, 1);
  assert.equal(checkDiff(diffAdding("a.ts", ["Kestrel and other works"]), { blocklist, allow: [] }).length, 0);
});

test("a clean diff passes, and removed or context lines are never checked", () => {
  const clean = diffAdding("ui/src/lib/x.ts", ['title: "Sign the Acme brief",', 'email: "ada@example.com",', 'token: "test-token-value-123"']);
  assert.deepEqual(checkDiff(clean, none), []);
  const removal = [
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,1 @@",
    `-const token = "${FAKE_GITHUB_TOKEN}"; // ${CLIENT_NAME}`, ` keep ${CLIENT_NAME}`, "+const token = process.env.TOKEN;", "",
  ].join("\n");
  assert.deepEqual(checkDiff(removal, none), []);
});

test("readable fixtures, sentinels and local database URLs are not secrets", () => {
  const lines = [
    'const secret = "sandbox-secret-marker-9f3c1a";',
    'apiKey: "paperclip-board-token-for-the-test",',
    'url: "postgres://paperclip:paperclip@localhost:5432/paperclip"',
    'const id = "8f884973-c29b-44e4-8ea3-6413437f8081";',
  ];
  assert.deepEqual(checkDiff(diffAdding("x.ts", lines), none), []);
});

test("the reviewed allow list lets a real fixture through for its file and rule only", () => {
  const diff = diffAdding("server/src/__tests__/pem.test.ts", ["-----BEGIN PRIVATE" + " KEY-----", `// ${CLIENT_NAME}`]);
  const allow = [{ path: "server/src/__tests__/pem.test.ts", rule: "private-key", reason: "Generated throwaway key for the parser test." }];
  assert.deepEqual(checkDiff(diff, { allow }).map((f) => f.rule), ["name"]);
  assert.deepEqual(checkDiff(diff, { allow: [{ path: "server/src/__tests__/", rule: "*", reason: "x" }] }), []);
});

test("the shipped blocklist holds only hashes, and allow entries need a reason", () => {
  const text = fs.readFileSync(fileURLToPath(new URL("./repo-hygiene/blocklist.sha256", import.meta.url)), "utf8");
  for (const line of text.split("\n")) assert.match(line, /^(#.*|[0-9a-f]{64}|)$/);
  assert.ok(loadBlocklist().has(hashName(CLIENT_NAME)));
  assert.ok(Array.isArray(loadAllow()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-allow-"));
  try {
    fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ entries: [{ path: "a.ts", rule: "name" }] }));
    assert.throws(() => loadAllow(path.join(dir, "allow.json")), /reason/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addedLines follows hunk line numbers across files", () => {
  const diff = [diffAdding("a.ts", ["one", "two"]), "diff --git a/b.ts b/b.ts", "--- /dev/null", "+++ b/b.ts", "@@ -0,0 +1 @@", "+three", ""].join("\n");
  assert.deepEqual(addedLines(diff).map((l) => `${l.path}:${l.line}:${l.text}`), ["a.ts:11:one", "a.ts:12:two", "b.ts:1:three"]);
});

test("--staged on a real repo: fails on a staged fake key and client name, passes once clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-repo-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM") delete env[key];
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, env, encoding: "utf8" });
  const run = () => spawnSync(process.execPath, [SCRIPT, "--staged"], { cwd: dir, env, encoding: "utf8" });
  try {
    assert.equal(git("init", "-q").status, 0);
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    git("add", "a.ts");
    assert.equal(git("commit", "-q", "-m", "init").status, 0);

    fs.writeFileSync(path.join(dir, "a.ts"), `export const a = 1;\nconst t = "${FAKE_GITHUB_TOKEN}"; // ${CLIENT_NAME}\n`);
    git("add", "a.ts");
    const dirty = run();
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stderr, /a\.ts:2: a possible secret \(github-token\)/);
    assert.match(dirty.stderr, /a\.ts:2: a blocklisted client or person name/);
    assert.ok(!dirty.stderr.includes(FAKE_GITHUB_TOKEN) && !dirty.stderr.includes(CLIENT_NAME));

    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\nconst t = process.env.TOKEN; // Acme\n");
    git("add", "a.ts");
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
