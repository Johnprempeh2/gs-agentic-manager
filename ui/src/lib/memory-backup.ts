import type { MemoryActivityFeed, MemoryActivityItem } from "@greatstone/shared";

/** Entries per request, the most the activity feed returns. */
export const MEMORY_BACKUP_PAGE = 200;
/** A backup stops here so one click can never page forever. */
export const MEMORY_BACKUP_MAX = 20_000;

export interface MemoryBackupEntry {
  id: string;
  scope: string;
  scopeKind: string;
  status: string;
  entryType: string;
  title: string | null;
  content: string | null;
  entities: string[];
  topics: string[];
  source: { kind: string | null; id: string | null };
  contributor: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryBackup {
  format: "gsam-memory-backup/v1";
  companyName: string;
  exportedAt: string;
  /** True when the backup stopped at MEMORY_BACKUP_MAX entries. */
  truncated: boolean;
  entries: MemoryBackupEntry[];
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

function contributorName(item: MemoryActivityItem): string {
  const actor = item.contributor;
  if (actor.name) return actor.name;
  if (actor.actorType === "agent") return "An agent";
  if (actor.actorType === "user") return "A person";
  return "GSAM";
}

function toEntry(item: MemoryActivityItem): MemoryBackupEntry {
  const record = item.record;
  return {
    id: record.id,
    scope: item.scopeName,
    scopeKind: record.scopeKind,
    status: record.status,
    entryType: record.entryType,
    title: record.title,
    content: record.content,
    entities: record.entities ?? [],
    topics: record.topics ?? [],
    source: { kind: item.source.kind, id: item.source.id },
    contributor: contributorName(item),
    supersedesId: record.supersedesId,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/**
 * Every memory entry the reader may see, newest first, paged through the
 * activity feed. Deleted entries are left out: they have no text to keep.
 */
export async function collectMemoryBackup(
  fetchPage: (cursor: string | undefined) => Promise<MemoryActivityFeed>,
  companyName: string,
  now = new Date(),
): Promise<MemoryBackup> {
  const entries: MemoryBackupEntry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (item.record.status === "deleted" || item.record.deletedAt) continue;
      entries.push(toEntry(item));
    }
    if (!page.nextCursor || page.items.length === 0) break;
    if (entries.length >= MEMORY_BACKUP_MAX) {
      truncated = true;
      break;
    }
    cursor = page.nextCursor;
  }
  return { format: "gsam-memory-backup/v1", companyName, exportedAt: now.toISOString(), truncated, entries: entries.slice(0, MEMORY_BACKUP_MAX) };
}

const STATUS_WORD: Record<string, string> = {
  approved: "Confirmed",
  unreviewed: "Waiting for review",
  disputed: "Disputed",
  superseded: "Replaced",
};

/** The same backup as plain text a person can read, grouped by where it lives. */
export function memoryBackupText(backup: MemoryBackup): string {
  const byScope = new Map<string, MemoryBackupEntry[]>();
  for (const entry of backup.entries) byScope.set(entry.scope, [...(byScope.get(entry.scope) ?? []), entry]);
  const lines = [
    `Memory backup for ${backup.companyName || "the company"}`,
    `Saved ${backup.exportedAt.slice(0, 10)}. ${backup.entries.length} ${backup.entries.length === 1 ? "entry" : "entries"}.`,
  ];
  if (backup.truncated) lines.push(`Only the newest ${backup.entries.length} entries are included.`);
  for (const [scope, entries] of [...byScope.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `## ${scope}`);
    for (const entry of entries) {
      const text = [entry.title, entry.content].filter(Boolean).join("\n").trim();
      lines.push("", `- ${STATUS_WORD[entry.status] ?? entry.status}, added ${entry.createdAt.slice(0, 10)} by ${entry.contributor}`);
      for (const line of text.split("\n")) lines.push(`  ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function memoryBackupFileName(companyName: string, now: Date, extension: "json" | "txt"): string {
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
  return `${slug}-memory-backup-${now.toISOString().slice(0, 10)}.${extension}`;
}
