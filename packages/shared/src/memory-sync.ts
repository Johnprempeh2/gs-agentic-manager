import { z } from "zod";

/**
 * One shared memory for a person's Claude Code, Codex and GSAM (GRE-2668).
 * The Mac sync (`scripts/shared-memory/`) and GSAM's own feed send entries
 * here; each lands in the person's own scope (`my_work`, bank
 * `greatstone-<first name>`). Every entry carries its source and a stable
 * source id. The server keeps a hash of the text, so a resend is skipped and a
 * changed source replaces its old entry instead of adding a second one.
 */

export const MEMORY_SYNC_SOURCES = ["claude_code", "codex", "memory_file", "gsam"] as const;
export type MemorySyncSource = (typeof MEMORY_SYNC_SOURCES)[number];

/** `sourceKind` on synced records: `sync:claude_code`, `sync:codex`, `sync:memory_file`, `sync:gsam`. */
export function memorySyncSourceKind(source: MemorySyncSource) {
  return `sync:${source}` as const;
}

/** Most entries one sync call takes. Each new or changed one is a retain, which is a model call. */
export const MEMORY_SYNC_MAX_ENTRIES = 25;

/**
 * Most new or changed entries one person scope takes in a UTC day, unless the
 * server sets `GSAM_MEMORY_SYNC_DAILY_CAP`. Past it, entries are answered
 * `capped` and the sender keeps them for the next day.
 */
export const MEMORY_SYNC_DEFAULT_DAILY_CAP = 300;

export const syncMemoryEntrySchema = z
  .object({
    source: z.enum(MEMORY_SYNC_SOURCES),
    /** Stable for the same turn, file or GSAM item, e.g. `claude:<session>:<first turn uuid>` or `memory:NOW.md`. */
    sourceId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200).optional().nullable(),
    content: z.string().trim().min(1).max(20_000),
    /** When it happened: the turn's time, the file's last change, the comment's time. */
    occurredAt: z.coerce.date(),
    /** Where it came from, for the answer's source line. No secrets: paths and ids only. */
    origin: z
      .object({
        app: z.string().trim().max(40).optional(),
        sessionId: z.string().trim().max(120).optional(),
        project: z.string().trim().max(300).optional(),
        path: z.string().trim().max(500).optional(),
        url: z.string().trim().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SyncMemoryEntry = z.infer<typeof syncMemoryEntrySchema>;

export const syncMemorySchema = z
  .object({
    entries: z.array(syncMemoryEntrySchema).min(1).max(MEMORY_SYNC_MAX_ENTRIES),
  })
  .strict();
export type SyncMemory = z.infer<typeof syncMemorySchema>;

/**
 * `added`: new. `unchanged`: same source id and hash as the live entry.
 * `revised`: the source changed; the old entry is superseded by this one.
 * `held_back`: it matched a secret or personal-data pattern after the sender's
 * redaction, so nothing was stored. `capped`: the daily cap was reached; send it again tomorrow.
 * `deleted_before`: someone deleted this source's entry; it is never stored again.
 */
export type MemorySyncEntryOutcome = "added" | "unchanged" | "revised" | "held_back" | "capped" | "deleted_before";

export interface MemorySyncResult {
  scopeId: string;
  bankName: string;
  entries: Array<{ sourceId: string; outcome: MemorySyncEntryOutcome; recordId: string | null }>;
  /** New or changed entries this scope took today (UTC), after this call. */
  usedToday: number;
  dailyCap: number;
  capReached: boolean;
}
