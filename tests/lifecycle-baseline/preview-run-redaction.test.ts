import { describe, expect, it, vi } from "vitest";
import type { Db } from "@greatstone/db";
import { REDACTED_EVENT_VALUE } from "../../server/src/redaction.js";
import { createRunSecretRedactionRegistry } from "../../server/src/services/run-secret-redaction.js";

const { resolveVersion } = vi.hoisted(() => ({
  resolveVersion: vi.fn(async ({ material }: { material: { value: string } }) => {
    if (material.value === "copied-with-live-key") throw new Error("Secret decryption failed");
    return material.value;
  }),
}));
vi.mock("../../server/src/secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({ resolveVersion }),
}));

describe("GRE-3062: copied-data preview with a different secrets key", () => {
  it("keeps the run list available without exposing unredactable fields", async () => {
    const rows = [
      { id: "copied", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "copied", material: { value: "copied-with-live-key" } }] } },
      { id: "readable", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "readable", material: { value: "preview-secret" } }] } },
    ];
    const db = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as Db;
    const runs = [
      { id: "copied", companyId: "company", agentId: "agent", status: "failed", startedAt: new Date("2026-10-28T06:00:00Z"), error: "copied-with-live-key", contextSnapshot: { issueId: "issue", paperclipSecretRedactions: [{ material: "ciphertext" }] } },
      { id: "readable", companyId: "company", agentId: "agent", status: "succeeded", startedAt: new Date("2026-10-28T06:01:00Z"), error: "preview-secret", contextSnapshot: { issueId: "issue" } },
    ];

    const result = await createRunSecretRedactionRegistry(db).redactForRuns("company", runs);

    expect(result[0]).toMatchObject({ id: "copied", status: "failed", secretRedactionState: "unavailable", error: null, contextSnapshot: null });
    expect(result[0].startedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(result[0])).not.toContain("copied-with-live-key");
    expect(JSON.stringify(result[0])).not.toContain("ciphertext");
    expect(result[1]).toMatchObject({ id: "readable", status: "succeeded", error: REDACTED_EVENT_VALUE });
    expect(result[1]).not.toHaveProperty("secretRedactionState");
  });
});
