import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expectedSum, fetchRunnerBinary, runnerAssetName } from "./fetch-runner-binary.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

async function serve(files) {
  const server = createServer((req, res) => {
    const body = files[req.url];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("names the asset per platform and CPU", () => {
  assert.equal(runnerAssetName("win32", "x64"), "paperclip-runnerd-windows-x64.exe");
  assert.equal(runnerAssetName("darwin", "arm64"), "paperclip-runnerd-macos-arm64");
  assert.equal(runnerAssetName("darwin", "x64"), "paperclip-runnerd-macos-x64");
  assert.equal(runnerAssetName("linux", "x64"), null);
});

test("reads a sum from SHA256SUMS", () => {
  const sums = `${"a".repeat(64)}  paperclip-runnerd-macos-arm64\n${"b".repeat(64)} *paperclip-runnerd-windows-x64.exe\r\n`;
  assert.equal(expectedSum(sums, "paperclip-runnerd-windows-x64.exe"), "b".repeat(64));
  assert.equal(expectedSum(sums, "paperclip-runnerd-macos-x64"), null);
});

test("installs a binary that matches its sum, and refuses one that does not", async () => {
  const asset = "paperclip-runnerd-windows-x64.exe";
  const good = "runner bytes";
  const dest = mkdtempSync(path.join(os.tmpdir(), "runner-fetch-"));
  const files = { "/live-1/SHA256SUMS": `${sha(good)}  ${asset}\n`, [`/live-1/${asset}`]: good };
  const server = await serve(files);
  try {
    const target = await fetchRunnerBinary({ tag: "live-1", dest, baseUrl: server.url, platform: "win32", arch: "x64" });
    assert.equal(target, path.join(dest, "paperclip-runnerd.exe"));
    assert.equal(readFileSync(target, "utf8"), good);

    // Planted failure: the bytes on the server change but the sum does not.
    files[`/live-1/${asset}`] = "tampered bytes";
    rmSync(target);
    await assert.rejects(
      fetchRunnerBinary({ tag: "live-1", dest, baseUrl: server.url, platform: "win32", arch: "x64" }),
      /does not match its SHA-256/,
    );
    assert.equal(existsSync(target), false);

    await assert.rejects(fetchRunnerBinary({ tag: "live-2", dest, baseUrl: server.url, platform: "win32", arch: "x64" }), /HTTP 404/);
    await assert.rejects(fetchRunnerBinary({ tag: "../x", dest, baseUrl: server.url }), /not a release tag/);
  } finally {
    server.close();
    rmSync(dest, { recursive: true, force: true });
  }
});
