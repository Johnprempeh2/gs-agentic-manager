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
