import { describe, expect, it, vi } from "vitest";
import type { MemoryActivityFeed, MemoryActivityItem } from "@greatstone/shared";
import { collectMemoryBackup, memoryBackupFileName, memoryBackupText } from "./memory-backup";

function item(id: string, status: string, content: string, scopeName = "Acme"): MemoryActivityItem {
  return {
    record: {
      id,
      scopeKind: "client",
      status,
      entryType: "observation",
      title: null,
      content,
      entities: [],
      topics: [],
      supersedesId: null,
      createdAt: "2026-10-14T09:00:00.000Z",
      updatedAt: "2026-10-14T09:00:00.000Z",
      deletedAt: status === "deleted" ? "2026-10-15T00:00:00.000Z" : null,
    },
    scopeName,
    contributor: { actorType: "user", agentId: null, userId: "u1", name: "Ben" },
    source: { kind: "chatgpt_import", id: "paste:abc", runId: null },
    history: [],
    extractedFactCount: 0,
  } as unknown as MemoryActivityItem;
}

describe("collectMemoryBackup", () => {
  it("pages through every entry and leaves deleted ones out", async () => {
    const pages: Record<string, MemoryActivityFeed> = {
      first: { items: [item("a", "approved", "Pays within 30 days."), item("b", "deleted", "")], nextCursor: "b" },
      b: { items: [item("c", "unreviewed", "Wants a monthly report.", "Greatstone")], nextCursor: null },
    };
    const fetchPage = vi.fn(async (cursor: string | undefined) => pages[cursor ?? "first"]!);
    const backup = await collectMemoryBackup(fetchPage, "Greatstone", new Date("2026-10-16T05:00:00Z"));
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "b"]);
    expect(backup.entries.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(backup.entries[0]).toMatchObject({ scope: "Acme", status: "approved", contributor: "Ben", source: { kind: "chatgpt_import" } });
    expect(backup).toMatchObject({ format: "gsam-memory-backup/v1", exportedAt: "2026-10-16T05:00:00.000Z", truncated: false });

    const text = memoryBackupText(backup);
    expect(text).toContain("Memory backup for Greatstone");
    expect(text).toContain("2 entries.");
    expect(text).toContain("## Acme\n\n- Confirmed, added 2026-10-14 by Ben\n  Pays within 30 days.");
    expect(text.indexOf("## Acme")).toBeLessThan(text.indexOf("## Greatstone"));
    expect(text).toContain("Waiting for review");
  });

  it("names the file after the company and the day", () => {
    expect(memoryBackupFileName("Greatstone International", new Date("2026-10-16T05:00:00Z"), "json")).toBe(
      "greatstone-international-memory-backup-2026-10-16.json",
    );
    expect(memoryBackupFileName("", new Date("2026-10-16T05:00:00Z"), "txt")).toBe("company-memory-backup-2026-10-16.txt");
  });
});
