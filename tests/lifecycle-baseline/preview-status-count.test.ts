import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/greatstone-preview.sh");
const common = resolve("scripts/greatstone-common.sh");
const startedAt = "2026-10-29T06:00:00Z";

async function statusWithResponse(status: number, body: unknown) {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/api/companies" ? 200 : status, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/companies" ? [{ id: "company-1" }] : body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const dir = await mkdtemp(join(tmpdir(), "preview-status-count-"));
  try {
    const fullScript = await readFile(script, "utf8");
    const source = fullScript
      .slice(0, fullScript.lastIndexOf('case "${1:-}" in'))
      .replace('"$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"', JSON.stringify(common));
    const harness = join(dir, "status.sh");
    await writeFile(harness, `${source}\npreview_running() { return 0; }\npreview_state() { case "$1" in started_at) echo ${startedAt} ;; *) echo fixture ;; esac; }\nhealth_commit() { echo fixture; }\npreview_migrations() { echo none; }\ncmd_status\n`);
    try {
      const result = await execFileAsync("bash", [harness], {
        env: { PATH: process.env.PATH, GSAM_ROOT: dir, GSAM_PREVIEW_PORT: String(address.port) },
        timeout: 10_000,
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code, output: (failure.stdout ?? "") + (failure.stderr ?? "") };
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

it("reports a failed run query as unknown rather than zero (GRE-3200)", async () => {
  const result = await statusWithResponse(500, { error: "Secret decryption failed" });
  expect(result.output).toMatch(/agent runs: (unknown|could not ask the preview)/);
  expect(result.output).not.toMatch(/agent runs: 0 started/);
});

it("counts successful preview run responses (GRE-3200)", async () => {
  const result = await statusWithResponse(200, [
    { id: "one", createdAt: "2026-10-29T06:01:00Z", status: "running" },
    { id: "two", createdAt: "2026-10-29T05:59:00Z", status: "succeeded" },
  ]);
  expect(result.code).toBe(0);
  expect(result.output).toMatch(/agent runs: 1 started since the preview started, 1 queued or running/);
});

it.each([
  { name: "an invalid run response", rows: { error: "failure" } },
  { name: "a truncated run response", rows: Array.from({ length: 200 }, (_, index) => ({ id: String(index), createdAt: startedAt, status: "succeeded" })) },
])("marks $name as unknown", async ({ rows }) => {
  const result = await statusWithResponse(200, rows);
  expect(result.output).toMatch(/agent runs: unknown/);
  expect(result.output).not.toMatch(/agent runs: \d+ started/);
});
