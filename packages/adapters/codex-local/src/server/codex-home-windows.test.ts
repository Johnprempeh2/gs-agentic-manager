import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedManagedCodexHome } from "./codex-home.js";

// Windows without the symlink privilege (a standard user, Developer Mode off:
// a customer's PC). Windows CI runs this file as such a user and sets
// GSAM_EXPECT_NO_SYMLINKS, so the first test proves the environment.
const onWindows = process.platform === "win32";

const subscriptionAuth = (accountId: string, marker: string, lastRefresh: string) =>
  JSON.stringify({
    tokens: {
      id_token: `synthetic-id-token-${marker}`,
      access_token: `synthetic-access-token-${marker}`,
      refresh_token: `synthetic-refresh-token-${marker}`,
      account_id: accountId,
    },
    last_refresh: lastRefresh,
  });

async function sameFile(a: string, b: string) {
  const [x, y] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })]);
  return x.ino === y.ino && x.dev === y.dev;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-win-"));
  const shared = path.join(root, "shared-codex-home");
  const home = path.join(root, "instances", "default", "companies", "company-1", "codex-home");
  await fs.mkdir(shared, { recursive: true });
  return { root, shared, home, sharedAuth: path.join(shared, "auth.json"), homeAuth: path.join(home, "auth.json") };
}

describe.runIf(onWindows)("Codex managed home on Windows without the symlink privilege", () => {
  it.runIf(process.env.GSAM_EXPECT_NO_SYMLINKS === "1")("runs where Windows refuses a file symlink (planted check of the environment)", async () => {
    const { root, sharedAuth } = await fixture();
    try {
      await fs.writeFile(sharedAuth, "{}", "utf8");
      await expect(fs.symlink(sharedAuth, path.join(root, "link.json"))).rejects.toMatchObject({ code: "EPERM" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("links auth.json to the shared credential, so a refresh written in place is shared at once", async () => {
    const { root, sharedAuth, home, homeAuth, shared } = await fixture();
    try {
      await fs.writeFile(sharedAuth, subscriptionAuth("acct-1", "first", "2026-11-01T00:00:00Z"), "utf8");
      await seedManagedCodexHome(home, { CODEX_HOME: shared }, async () => {});
      expect(await sameFile(homeAuth, sharedAuth)).toBe(true);

      await fs.writeFile(homeAuth, subscriptionAuth("acct-1", "refreshed", "2026-11-02T00:00:00Z"), "utf8");
      expect(await fs.readFile(sharedAuth, "utf8")).toContain("synthetic-refresh-token-refreshed");

      // A second seed keeps the link.
      await seedManagedCodexHome(home, { CODEX_HOME: shared }, async () => {});
      expect(await sameFile(homeAuth, sharedAuth)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("carries a newer credential from a split home back to the shared one", async () => {
    const { root, sharedAuth, home, homeAuth, shared } = await fixture();
    try {
      await fs.writeFile(sharedAuth, subscriptionAuth("acct-1", "old", "2026-11-01T00:00:00Z"), "utf8");
      await seedManagedCodexHome(home, { CODEX_HOME: shared }, async () => {});
      // A writer that replaces the file (write a new one, rename over) splits the hard link.
      const staged = `${homeAuth}.new`;
      await fs.writeFile(staged, subscriptionAuth("acct-1", "new", "2026-11-03T00:00:00Z"), "utf8");
      await fs.rm(homeAuth);
      await fs.rename(staged, homeAuth);
      expect(await sameFile(homeAuth, sharedAuth)).toBe(false);

      await seedManagedCodexHome(home, { CODEX_HOME: shared }, async () => {});
      expect(await fs.readFile(sharedAuth, "utf8")).toContain("synthetic-refresh-token-new");
      expect(await fs.readFile(homeAuth, "utf8")).toContain("synthetic-refresh-token-new");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never sends another account's credential to the shared one", async () => {
    const { root, sharedAuth, home, homeAuth, shared } = await fixture();
    try {
      await fs.writeFile(sharedAuth, subscriptionAuth("acct-host", "host", "2026-11-01T00:00:00Z"), "utf8");
      await fs.mkdir(home, { recursive: true });
      // A promoted company credential for another account, newer than the host's.
      await fs.writeFile(homeAuth, subscriptionAuth("acct-company", "company", "2026-11-05T00:00:00Z"), "utf8");
      await seedManagedCodexHome(home, { CODEX_HOME: shared }, async () => {});
      expect(await fs.readFile(sharedAuth, "utf8")).toContain("synthetic-refresh-token-host");
      expect(await fs.readFile(homeAuth, "utf8")).toContain("synthetic-refresh-token-company");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
