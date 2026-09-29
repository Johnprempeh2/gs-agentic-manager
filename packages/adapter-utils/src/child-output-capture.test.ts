import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHILD_OUTPUT_FILES_ENV,
  readCapturedOutputFile,
  splitCompleteUtf8,
} from "./child-output-capture.js";
import { runChildProcess } from "./server-utils.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-child-output-"));
});

afterEach(async () => {
  delete process.env[CHILD_OUTPUT_FILES_ENV];
  await fs.rm(dir, { recursive: true, force: true });
});

async function runNode(
  script: string,
  opts: { capture: boolean; terminalResult?: boolean },
) {
  const logs: Array<[string, string]> = [];
  const spawns: Array<{ outputCapture?: unknown }> = [];
  const result = await runChildProcess(
    randomUUID(),
    process.execPath,
    ["-e", script],
    {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 20,
      graceSec: 1,
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onSpawn: async (meta) => {
        spawns.push(meta);
      },
      ...(opts.capture ? { outputCapture: { dir } } : {}),
      ...(opts.terminalResult
        ? {
            terminalResultCleanup: {
              graceMs: 50,
              hasTerminalResult: ({ stdout }: { stdout: string }) =>
                stdout.includes('"type":"result"'),
            },
          }
        : {}),
    },
  );
  const joined = (stream: string) =>
    logs.filter(([s]) => s === stream).map(([, c]) => c).join("");
  return { result, logs, spawns, onLogStdout: joined("stdout"), onLogStderr: joined("stderr") };
}

function waitFor(check: () => boolean, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("runChildProcess with file-backed output", () => {
  const script = [
    "process.stdout.write('out-1\\n');",
    "process.stderr.write('err-1\\n');",
    "setTimeout(() => { process.stdout.write('out-2\\n'); process.exitCode = 3; }, 150);",
  ].join(" ");

  it("gives the same stdout, stderr, onLog text and exit code as pipes", async () => {
    const piped = await runNode(script, { capture: false });
    const filed = await runNode(script, { capture: true });

    expect(filed.result.exitCode).toBe(3);
    expect(filed.result.exitCode).toBe(piped.result.exitCode);
    expect(filed.result.stdout).toBe(piped.result.stdout);
    expect(filed.result.stderr).toBe(piped.result.stderr);
    expect(filed.onLogStdout).toBe("out-1\nout-2\n");
    expect(filed.onLogStderr).toBe("err-1\n");

    const capture = filed.spawns[0]?.outputCapture as
      | { stdoutPath: string; stderrPath: string }
      | undefined;
    expect(capture?.stdoutPath.startsWith(dir)).toBe(true);
    expect(piped.spawns[0]?.outputCapture).toBeUndefined();
    // The run log holds the output now, so the files are removed.
    expect(existsSync(capture!.stdoutPath)).toBe(false);
    expect(existsSync(capture!.stderrPath)).toBe(false);
  });

  it("keeps a multi-byte character split across two writes", async () => {
    const filed = await runNode(
      [
        "const b = Buffer.from('h\\u00e9\\u20ac!', 'utf8');",
        "process.stdout.write(b.subarray(0, 2));",
        "setTimeout(() => process.stdout.write(b.subarray(2, 4)), 250);",
        "setTimeout(() => process.stdout.write(b.subarray(4)), 500);",
      ].join(" "),
      { capture: true },
    );
    expect(filed.result.stdout).toBe("hé€!");
    expect(filed.onLogStdout).not.toContain("�");
  });

  it("does not lose bytes written just before exit", async () => {
    const filed = await runNode(
      "process.stdout.write('x'.repeat(1024 * 1024) + 'END'); process.exit(0);",
      { capture: true },
    );
    expect(filed.result.stdout.length).toBe(1024 * 1024 + 3);
    expect(filed.result.stdout.endsWith("END")).toBe(true);
  });

  it("still stops a child that hangs after its terminal result", async () => {
    const filed = await runNode(
      "process.stdout.write(JSON.stringify({ type: 'result' }) + '\\n'); setInterval(() => {}, 1000);",
      { capture: true, terminalResult: true },
    );
    expect(filed.result.terminalResultCleanup?.stopped).toBe(true);
    expect(filed.result.stdout).toContain('"type":"result"');
  });

  it("uses pipes when GSAM_CHILD_OUTPUT_FILES=0", async () => {
    process.env[CHILD_OUTPUT_FILES_ENV] = "0";
    const filed = await runNode("process.stdout.write('ok');", { capture: true });
    expect(filed.result.stdout).toBe("ok");
    expect(filed.spawns[0]?.outputCapture).toBeUndefined();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

// The old server is a real process that spawns a detached child and exits,
// as it does on a hot restart. The child writes after the server is gone.
describe.skipIf(process.platform === "win32")("output after the spawning server exits", () => {
  async function spawnThroughExitingServer(mode: "pipe" | "file") {
    const marker = path.join(dir, `${mode}.done`);
    const outFile = path.join(dir, `${mode}.stdout`);
    const childScript = [
      "setTimeout(() => {",
      "  process.stdout.write('after restart\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\\n', (err) => {",
      `    if (!err) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok');`,
      "  });",
      "}, 400);",
    ].join("\n");
    const serverScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const mode = ${JSON.stringify(mode)};`,
      `const out = mode === 'file' ? fs.openSync(${JSON.stringify(outFile)}, 'a', 0o600) : 'pipe';`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: ['ignore', out, 'ignore'] });`,
      "child.unref();",
      "if (mode === 'pipe') { child.stdout.on('data', () => {}); child.stdout.unref?.(); }",
      "process.stdout.write(String(child.pid));",
      "setTimeout(() => process.exit(0), 50);",
    ].join("\n");
    const server = spawn(process.execPath, ["-e", serverScript], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let pidText = "";
    server.stdout.on("data", (c) => (pidText += String(c)));
    await new Promise((resolve) => server.on("close", resolve));
    const childPid = Number.parseInt(pidText, 10);
    const exited = await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    return { exited, finishedCleanly: existsSync(marker), outFile };
  }

  it("a piped child fails its write once the server that read the pipe is gone (EPIPE)", async () => {
    const piped = await spawnThroughExitingServer("pipe");
    expect(piped.exited).toBe(true);
    expect(piped.finishedCleanly).toBe(false);
  });

  it("a file-backed child keeps writing, finishes, and its result is in the file", async () => {
    const filed = await spawnThroughExitingServer("file");
    expect(filed.exited).toBe(true);
    expect(filed.finishedCleanly).toBe(true);
    const read = await readCapturedOutputFile(filed.outFile);
    expect(read?.text).toContain('"type":"result"');
  });
});

describe("readCapturedOutputFile", () => {
  it("keeps the head and the tail of a large file, cut at whole lines", async () => {
    const file = path.join(dir, "big.stdout");
    const head = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" });
    const filler = Array.from({ length: 2000 }, (_, i) => `{"type":"assistant","n":${i}}`).join("\n");
    const tail = JSON.stringify({ type: "result", session_id: "sess-1" });
    await fs.writeFile(file, `${head}\n${filler}\n${tail}\n`);

    const read = await readCapturedOutputFile(file, { headBytes: 200, tailBytes: 400 });
    expect(read?.truncated).toBe(true);
    const lines = read!.text.trim().split("\n");
    expect(lines[0]).toBe(head);
    expect(lines.at(-1)).toBe(tail);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("reads from an offset and returns null for a missing file", async () => {
    const file = path.join(dir, "small.stdout");
    await fs.writeFile(file, "logged\nnew\n");
    expect((await readCapturedOutputFile(file, { fromOffset: 7 }))?.text).toBe("new\n");
    expect(await readCapturedOutputFile(path.join(dir, "missing"))).toBeNull();
  });
});

describe("splitCompleteUtf8", () => {
  it("holds back an incomplete trailing sequence", () => {
    const euro = Buffer.from("€", "utf8");
    const [complete, rest] = splitCompleteUtf8(Buffer.concat([Buffer.from("a"), euro.subarray(0, 2)]));
    expect(complete.toString()).toBe("a");
    expect(rest.length).toBe(2);
    const [whole, none] = splitCompleteUtf8(Buffer.concat([Buffer.from("a"), euro]));
    expect(whole.toString()).toBe("a€");
    expect(none.length).toBe(0);
  });
});
