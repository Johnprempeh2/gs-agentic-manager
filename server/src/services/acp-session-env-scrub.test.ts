import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACP_SESSION_ENV_SCRUB_MARKER, scrubAcpSessionEnvironments } from "./acp-session-env-scrub.js";

const FAKE_KEY = "fake-run-jwt-for-test";

function sessionRecord(withEnv: boolean) {
  return {
    schema: "acpx.session.v1",
    acpx_record_id: "rec-1",
    messages: [{ role: "user", content: "hello" }],
    acpx: {
      current_model_id: "model-a",
      session_options: {
        ...(withEnv ? { env: { GSAM_API_KEY: FAKE_KEY, GSAM_GIT_TOKEN: "fake-git" } } : {}),
        model: "model-a",
      },
    },
  };
}

describe("scrubAcpSessionEnvironments (GRE-510)", () => {
  let root: string;
  let sessionsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "acp-env-scrub-"));
    sessionsDir = path.join(root, "companies", "company-1", "acp-engine", "agents", "agent-1", "sessions");
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await chmod(sessionsDir, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("removes session_options.env, keeps every other field, and skips bad JSON", async () => {
    await writeFile(path.join(sessionsDir, "a.json"), `${JSON.stringify(sessionRecord(true), null, 2)}\n`);
    await writeFile(path.join(sessionsDir, "b.json"), `${JSON.stringify(sessionRecord(false), null, 2)}\n`);
    await writeFile(path.join(sessionsDir, "bad.json"), "{ \"env\": not json");

    const result = await scrubAcpSessionEnvironments(root);

    expect(result).toMatchObject({ alreadyDone: false, scanned: 3, cleaned: 1, unparseable: 1, failed: 0 });
    const cleaned = JSON.parse(await readFile(path.join(sessionsDir, "a.json"), "utf8"));
    const expected = sessionRecord(false);
    expect(cleaned).toEqual(expected);
    expect(await readFile(path.join(sessionsDir, "a.json"), "utf8")).not.toContain(FAKE_KEY);
    expect((await stat(path.join(sessionsDir, "a.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(sessionsDir, "bad.json"), "utf8")).toBe("{ \"env\": not json");
    expect((await readdir(sessionsDir)).sort()).toEqual(["a.json", "b.json", "bad.json"]);
    expect(result.skippedPaths).toEqual([path.join(sessionsDir, "bad.json")]);
  });

  it("redacts the record's own env values from printed tool output (GRE-517)", async () => {
    const record = sessionRecord(true);
    const printed = `GSAM_API_KEY=${FAKE_KEY}\nHOME=/fixture`;
    record.messages = [{ Agent: { content: [{ Text: printed }], tool_results: { t1: { output: printed } } } }] as never;
    await writeFile(path.join(sessionsDir, "a.json"), JSON.stringify(record));

    const result = await scrubAcpSessionEnvironments(root);

    expect(result).toMatchObject({ cleaned: 1, failed: 0 });
    const text = await readFile(path.join(sessionsDir, "a.json"), "utf8");
    expect(text).not.toContain(FAKE_KEY);
    const saved = JSON.parse(text);
    expect(saved.messages[0].Agent.tool_results.t1.output).toBe("GSAM_API_KEY=***REDACTED***\nHOME=/fixture");
    expect(saved.messages[0].Agent.content[0].Text).toBe("GSAM_API_KEY=***REDACTED***\nHOME=/fixture");
  });

  it("redacts run tokens by shape when env was already removed, and keeps other JWTs (GRE-517)", async () => {
    const jwt = (claims: Record<string, unknown>) =>
      [{ alg: "HS256", typ: "JWT" }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".")
      + ".c2lnbmF0dXJlLWZpeHR1cmUtdmFsdWU";
    const runToken = jwt({ sub: "agent-1", company_id: "company-1", run_id: "run-1", exp: 1 });
    const otherToken = jwt({ sub: "user-1", aud: "elsewhere" });
    const record = sessionRecord(false);
    record.messages = [{ Agent: { tool_results: { t1: { output: `GSAM_API_KEY=${runToken}\nOTHER=${otherToken}` } } } }] as never;
    await writeFile(path.join(sessionsDir, "a.json"), JSON.stringify(record));

    const result = await scrubAcpSessionEnvironments(root);

    expect(result).toMatchObject({ cleaned: 1, failed: 0 });
    const saved = JSON.parse(await readFile(path.join(sessionsDir, "a.json"), "utf8"));
    expect(saved.messages[0].Agent.tool_results.t1.output).toBe(`GSAM_API_KEY=***REDACTED***\nOTHER=${otherToken}`);
  });

  it("does no writes on a second start", async () => {
    await writeFile(path.join(sessionsDir, "a.json"), JSON.stringify(sessionRecord(true)));
    await scrubAcpSessionEnvironments(root);
    const mtimeAfterFirst = (await stat(path.join(sessionsDir, "a.json"))).mtimeMs;
    // A record that still holds env proves the second start does not walk the folder.
    await writeFile(path.join(sessionsDir, "late.json"), JSON.stringify(sessionRecord(true)));
    const lateMtime = (await stat(path.join(sessionsDir, "late.json"))).mtimeMs;

    const second = await scrubAcpSessionEnvironments(root);

    expect(second).toMatchObject({ alreadyDone: true, scanned: 0, cleaned: 0 });
    expect((await stat(path.join(sessionsDir, "a.json"))).mtimeMs).toBe(mtimeAfterFirst);
    expect((await stat(path.join(sessionsDir, "late.json"))).mtimeMs).toBe(lateMtime);
  });

  it("does not fail when the companies folder is missing", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "acp-env-scrub-empty-"));
    try {
      const result = await scrubAcpSessionEnvironments(empty);
      expect(result).toMatchObject({ alreadyDone: false, scanned: 0, cleaned: 0, failed: 0 });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "does not fail when a file cannot be written, and retries on the next start",
    async () => {
      const file = path.join(sessionsDir, "a.json");
      await writeFile(file, JSON.stringify(sessionRecord(true)));
      await chmod(sessionsDir, 0o555);

      const first = await scrubAcpSessionEnvironments(root);

      expect(first).toMatchObject({ scanned: 1, cleaned: 0, failed: 1 });
      expect(await readFile(file, "utf8")).toContain(FAKE_KEY);
      await expect(stat(path.join(root, ACP_SESSION_ENV_SCRUB_MARKER))).rejects.toThrow();

      await chmod(sessionsDir, 0o755);
      const second = await scrubAcpSessionEnvironments(root);
      expect(second).toMatchObject({ alreadyDone: false, cleaned: 1, failed: 0 });
      expect(await readFile(file, "utf8")).not.toContain(FAKE_KEY);
    },
  );
});
