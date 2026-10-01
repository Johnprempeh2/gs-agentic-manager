import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, heartbeatRuns } from "@greatstone/db";
import type { TranscriptEntry } from "@greatstone/adapter-utils";
import {
  RUN_LOG_READ_LIMIT_BYTES,
  buildRunLogTranscriptDigest,
  type TranscriptParserSource,
} from "@greatstone/adapter-utils/run-log-transcript";
import { parseClaudeStdoutLine } from "@greatstone/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@greatstone/adapter-codex-local/ui";
import { parseCursorCloudStdoutLine } from "@greatstone/adapter-cursor-cloud/ui";
import { parseCursorStdoutLine } from "@greatstone/adapter-cursor-local/ui";
import { parseGeminiStdoutLine } from "@greatstone/adapter-gemini-local/ui";
import { createGrokStdoutParser, parseGrokStdoutLine } from "@greatstone/adapter-grok-local/ui";
import { parseKimiStdoutLine } from "@greatstone/adapter-kimi-local/ui";
import { parseOpenClawGatewayStdoutLine } from "@greatstone/adapter-openclaw-gateway/ui";
import { parseOpenCodeStdoutLine } from "@greatstone/adapter-opencode-local/ui";
import { parsePiStdoutLine } from "@greatstone/adapter-pi-local/ui";
import { HttpError } from "../errors.js";
import { getAdapterPluginByType } from "./adapter-plugin-store.js";

/**
 * The parser the board uses for each built-in adapter type. Keep in step with
 * ui/src/adapters/<type>/index.ts (ui/src/adapters/digest-parsers.test.ts pins
 * the board side). Types whose parser exists only in the board (paperclip_runner,
 * process, http) get no digest, so the board reads their log as before.
 */
export const DIGEST_PARSERS: Readonly<Record<string, TranscriptParserSource>> = {
  claude_local: { parseStdoutLine: parseClaudeStdoutLine },
  codex_local: { parseStdoutLine: parseCodexStdoutLine },
  cursor_cloud: { parseStdoutLine: parseCursorCloudStdoutLine },
  cursor: { parseStdoutLine: parseCursorStdoutLine },
  gemini_local: { parseStdoutLine: parseGeminiStdoutLine },
  grok_local: { parseStdoutLine: parseGrokStdoutLine, createStdoutParser: createGrokStdoutParser },
  kimi_local: { parseStdoutLine: parseKimiStdoutLine },
  openclaw_gateway: { parseStdoutLine: parseOpenClawGatewayStdoutLine },
  opencode_local: { parseStdoutLine: parseOpenCodeStdoutLine },
  pi_local: { parseStdoutLine: parsePiStdoutLine },
};

const TERMINAL_STATUSES = new Set(["failed", "timed_out", "cancelled", "interrupted", "succeeded"]);
// ponytail: in-process LRU of finished-run digests; persist at run finish if
// cold starts ever make the first open slow.
const CACHE_LIMIT = 500;

type LogHandle = { id: string; companyId: string; logStore: string | null; logRef: string | null };

export interface DigestRun extends LogHandle {
  status: string;
  runtimeMode: string;
  logBytes: number | null;
  adapterType: string;
}

export interface RunTranscriptDigestDeps {
  readLog: (run: LogHandle, opts: { offset: number; limitBytes: number }) => Promise<{ content: string }>;
  redactForRun: <T>(companyId: string, runId: string, value: T) => Promise<T>;
}

/**
 * Structure-only transcripts of finished runs, so a task page can draw each
 * folded run row without downloading its log. The read window, redaction and
 * parse match what the board does with the full log (see buildRunLogTranscriptDigest).
 */
export function createRunTranscriptDigester(deps: RunTranscriptDigestDeps) {
  const cache = new Map<string, TranscriptEntry[] | null>();

  return async function digestRun(run: DigestRun): Promise<TranscriptEntry[] | null> {
    const parser = DIGEST_PARSERS[run.adapterType];
    if (
      !parser ||
      run.runtimeMode === "native" ||
      !TERMINAL_STATUSES.has(run.status) ||
      // An installed external adapter may replace the board's parser.
      getAdapterPluginByType(run.adapterType)
    ) {
      return null;
    }
    const key = `${run.id}:${run.logBytes ?? ""}:${run.adapterType}`;
    if (cache.has(key)) {
      const cached = cache.get(key)!;
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }

    // The board reads the last RUN_LOG_READ_LIMIT_BYTES of a finished log.
    const offset =
      typeof run.logBytes === "number" && run.logBytes > 0
        ? Math.max(0, run.logBytes - RUN_LOG_READ_LIMIT_BYTES)
        : 0;
    let content = "";
    if (run.logStore && run.logRef) {
      try {
        const read = await deps.readLog(run, { offset, limitBytes: RUN_LOG_READ_LIMIT_BYTES });
        content = (await deps.redactForRun(run.companyId, run.id, read)).content;
      } catch (error) {
        // A missing log reads as an empty transcript on the board too. Any other
        // failure leaves the run to the board's own read and its error state.
        if (!(error instanceof HttpError && error.status === 404)) return null;
      }
    }

    const digest = buildRunLogTranscriptDigest(run.id, content, parser);
    cache.set(key, digest);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return digest;
  };
}

export function runTranscriptDigestService(db: Db, deps: RunTranscriptDigestDeps) {
  const digestRun = createRunTranscriptDigester(deps);
  return {
    forRuns: async (companyId: string, runIds: string[]) => {
      if (runIds.length === 0) return {};
      const runs = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          status: heartbeatRuns.status,
          runtimeMode: heartbeatRuns.runtimeMode,
          logBytes: heartbeatRuns.logBytes,
          logStore: heartbeatRuns.logStore,
          logRef: heartbeatRuns.logRef,
          adapterType: agents.adapterType,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
      const digests: Record<string, TranscriptEntry[] | null> = {};
      await Promise.all(runs.map(async (run) => {
        digests[run.id] = await digestRun(run);
      }));
      return digests;
    },
  };
}
