// Tests for the environment scripts/greatstone-preview.sh gives the preview
// server. Only the variable setup is run: no preview is started, and nothing
// under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
