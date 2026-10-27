import { describe, expect, it } from "vitest";
import type { Db } from "@greatstone/db";
import { createGitRemoteAuthProvider } from "../../server/src/services/git-credentials.js";

describe("GRE-2956 background project Git consent", () => {
  it("never uses a server token for an issue-only workspace rebuild", async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Db;
    const provider = createGitRemoteAuthProvider(db, "company-1", { issueId: "issue-1" }, {
      env: { GITHUB_TOKEN: "legacy-server-token" },
      secrets: { getByName: async () => null, resolveSecretValue: async () => "" } as never,
    });

    await expect(provider("https://github.com/example/private.git"))
      .rejects.toThrow(/project|consent|workspace/i);
  });

  it("denies a credentialed or unsupported background remote before ambient Git can run", async () => {
    const db = {} as Db;
    const provider = createGitRemoteAuthProvider(db, "company-1", { issueId: "issue-1" });
    await expect(provider("https://user:password@github.com/example/private.git"))
      .rejects.toThrow(/unsupported/i);
    await expect(provider("https://gitlab.com/example/private.git"))
      .rejects.toThrow(/unsupported/i);
  });
});
