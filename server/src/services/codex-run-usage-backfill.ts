// Recompute stored token usage of past Codex (codex_local) runs from the Codex
// session rollout files, which record every model request. Before the
// codex-acp turn-usage fix, ACP runs stored only the LAST request of the run.
// Runs on live only when John decides (scripts/backfill-codex-run-usage.ts).
// Idempotent: a run already backfilled (usageJson.usageBackfill) is skipped.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agentRuntimeState, agents, costEvents, heartbeatRuns } from "@greatstone/db";
import { computeApiEquivalentCents } from "@greatstone/shared";

export type RolloutUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; requests: number };

/** Thread id from a rollout file name (`rollout-<time>-<threadId>.jsonl`), or null. */
export function rolloutThreadId(fileName: string): string | null {
  const match = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Sum the model requests whose `token_count` event falls inside [from, to].
 * Codex writes one after every request, with `last` (that request) and `total`
 * (the session counter), and re-sends an unchanged pair on rate-limit
 * refreshes, so each request counts once per changed total. Summing `last`
 * equals the total delta while the counter is continuous and still counts
 * every request after a resume restarts it. Stored shape follows OpenAI:
 * cached reads are inside inputTokens. Null when no request is in the window.
 */
export function sumRolloutUsageInWindow(text: string, from: Date | string, to: Date | string): RolloutUsage | null {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  let previousTotal: string | null = null;
  const sum: RolloutUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0 };
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let event: { timestamp?: string; payload?: { type?: string; info?: Record<string, Record<string, number>> | null } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const info = event.payload?.type === "token_count" ? event.payload.info : null;
    if (!info?.total_token_usage || !info.last_token_usage) continue;
    const total = JSON.stringify(info.total_token_usage);
    const repeated = total === previousTotal;
    previousTotal = total;
    if (repeated) continue;
    const at = new Date(event.timestamp ?? "").getTime();
    if (!(at >= fromMs && at <= toMs)) continue;
    const last = info.last_token_usage;
    sum.inputTokens += last.input_tokens ?? 0;
    sum.cachedInputTokens += last.cached_input_tokens ?? 0;
    sum.outputTokens += last.output_tokens ?? 0;
    sum.requests += 1;
  }
  return sum.requests > 0 ? sum : null;
}

function indexRollouts(roots: string[], warn: (line: string) => void): Map<string, string[]> {
  const byThread = new Map<string, string[]>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      warn(`Sessions root not readable, skipped: ${root}`);
      continue;
    }
    for (const entry of entries) {
      const threadId = rolloutThreadId(path.basename(entry));
      if (threadId) byThread.set(threadId, [...(byThread.get(threadId) ?? []), path.join(root, entry)]);
    }
  }
  return byThread;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export async function backfillCodexRunUsage(
  db: Db,
  options: { sessionsRoots: string[]; companyId?: string | null; apply: boolean; log?: (line: string) => void },
) {
  const log = options.log ?? (() => {});
  const rollouts = indexRollouts(options.sessionsRoots, log);
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      usageJson: heartbeatRuns.usageJson,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(and(
      eq(agents.adapterType, "codex_local"),
      isNotNull(heartbeatRuns.startedAt),
      isNotNull(heartbeatRuns.finishedAt),
      options.companyId ? eq(heartbeatRuns.companyId, options.companyId) : undefined,
    ));

  const counts = { runs: runs.length, rollouts: rollouts.size, changed: 0, unchanged: 0, alreadyBackfilled: 0, noRollout: 0, noRequestsInWindow: 0, noUsage: 0 };
  const tokens = { before: 0, after: 0 };
  for (const run of runs) {
    const usage = run.usageJson ?? null;
    if (!usage) { counts.noUsage += 1; continue; }
    if (usage.usageBackfill) { counts.alreadyBackfilled += 1; continue; }
    const threadIds = [run.sessionIdAfter, run.sessionIdBefore].filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase());
    const files = new Set(threadIds.flatMap((id) => rollouts.get(id) ?? []));
    if (files.size === 0) { counts.noRollout += 1; continue; }
    // A resumed thread may span several rollout files; the window keeps only this run.
    const after = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let requests = 0;
    for (const file of files) {
      const part = sumRolloutUsageInWindow(readFileSync(file, "utf8"), run.startedAt!, run.finishedAt!);
      if (!part) continue;
      after.inputTokens += part.inputTokens;
      after.cachedInputTokens += part.cachedInputTokens;
      after.outputTokens += part.outputTokens;
      requests += part.requests;
    }
    if (requests === 0) { counts.noRequestsInWindow += 1; continue; }

    const before = { inputTokens: num(usage.inputTokens), cachedInputTokens: num(usage.cachedInputTokens), outputTokens: num(usage.outputTokens) };
    if (before.inputTokens === after.inputTokens && before.cachedInputTokens === after.cachedInputTokens && before.outputTokens === after.outputTokens) {
      counts.unchanged += 1;
      continue;
    }
    counts.changed += 1;
    tokens.before += before.inputTokens + before.outputTokens;
    tokens.after += after.inputTokens + after.outputTokens;
    // Only our own API-equivalent estimates are recomputed; reported costs stay.
    const cents = usage.costStatus === "estimated" || usage.costStatus === "unpriced"
      ? computeApiEquivalentCents({ provider: String(usage.provider ?? ""), model: String(usage.model ?? ""), ...after }, run.startedAt!)
      : null;
    log(
      `${run.id} agent ${run.agentId}: ${requests} requests; in/cached/out ${before.inputTokens}/${before.cachedInputTokens}/${before.outputTokens}`
      + ` -> ${after.inputTokens}/${after.cachedInputTokens}/${after.outputTokens}`
      + (cents != null ? `; estimate $${num(usage.costUsd).toFixed(4)} -> $${(cents / 100).toFixed(4)}` : ""),
    );
    if (!options.apply) continue;

    const nextUsage: Record<string, unknown> = {
      ...usage,
      ...after,
      usageBackfill: { source: "codex_rollout", requests, previous: before, at: new Date().toISOString() },
      ...(cents != null ? { costUsd: cents / 100, costStatus: "estimated" } : {}),
    };
    delete nextUsage.usageCompleteness;
    await db.transaction(async (tx) => {
      await tx.update(heartbeatRuns).set({ usageJson: nextUsage }).where(eq(heartbeatRuns.id, run.id));
      await tx
        .update(costEvents)
        .set(after)
        .where(and(eq(costEvents.heartbeatRunId, run.id), eq(costEvents.companyId, run.companyId)));
      await tx
        .update(agentRuntimeState)
        .set({
          totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${after.inputTokens - before.inputTokens}`,
          totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${after.cachedInputTokens - before.cachedInputTokens}`,
          totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${after.outputTokens - before.outputTokens}`,
        })
        .where(and(eq(agentRuntimeState.agentId, run.agentId), eq(agentRuntimeState.companyId, run.companyId)));
    });
  }
  return { ...counts, tokens, applied: options.apply };
}
