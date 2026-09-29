import {
  API_PRICE_TABLE_CHECKED_AT,
  computeApiEquivalentCents,
  type CostLedger,
  type CostLedgerLine,
  type CostLedgerTotal,
} from "@greatstone/shared";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, costEvents } from "@greatstone/db";
import { badRequest } from "../errors.js";

const SEAT_PLAN_BILLING_TYPES = new Set(["subscription_included", "subscription_overage"]);
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface LedgerMonth {
  month: string;
  start: Date;
  end: Date;
}

/** Parse "YYYY-MM" into its UTC window; no value means the current UTC month. */
export function parseLedgerMonth(raw: unknown, now = new Date()): LedgerMonth {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      month: `${year}-${String(month + 1).padStart(2, "0")}`,
      start: new Date(Date.UTC(year, month, 1)),
      end: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  const match = typeof value === "string" ? MONTH_PATTERN.exec(value) : null;
  if (!match) throw badRequest("invalid 'month' value, expected YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return {
    month: value as string,
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

function emptyTotal(key: string, label: string | null): CostLedgerTotal {
  return {
    key,
    label,
    runCount: 0,
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    billedCents: 0,
    apiEquivalentCents: 0,
    billedLedgerCents: 0,
    apiEquivalentLedgerCents: 0,
    ledgerCents: 0,
    unpricedTokens: 0,
  };
}

interface TotalAccumulator {
  total: CostLedgerTotal;
  runs: Set<string>;
}

function addLine(acc: TotalAccumulator, line: CostLedgerLine, runIds: Set<string>) {
  const { total } = acc;
  total.eventCount += line.eventCount;
  total.inputTokens += line.inputTokens;
  total.cachedInputTokens += line.cachedInputTokens;
  total.outputTokens += line.outputTokens;
  total.billedCents += line.billedCents;
  total.apiEquivalentCents += line.apiEquivalentCents ?? 0;
  if (line.basis === "api_equivalent") total.apiEquivalentLedgerCents += line.ledgerCents;
  else total.billedLedgerCents += line.ledgerCents;
  total.ledgerCents += line.ledgerCents;
  total.unpricedTokens += line.unpricedTokens;
  for (const runId of runIds) acc.runs.add(runId);
}

function finishTotals(map: Map<string, TotalAccumulator>) {
  return [...map.values()]
    .map(({ total, runs }) => ({ ...total, runCount: runs.size }))
    .sort((a, b) => b.ledgerCents - a.ledgerCents || a.key.localeCompare(b.key));
}

/**
 * Monthly cost ledger for one install: cost per agent, provider and tool
 * (adapter type), built from the recorded cost events of the month.
 *
 * Seat-plan (subscription) runs record no billed cost, so their ledger amount
 * is the API-price equivalent of their tokens and the line is marked
 * `basis: "api_equivalent"`. All other lines use the recorded cost.
 *
 * The tool is the agent's current adapter type; cost events do not store it.
 */
export function costLedgerService(db: Db) {
  return {
    monthly: async (companyId: string, month: LedgerMonth): Promise<CostLedger> => {
      const tool = sql<string>`coalesce(${agents.adapterType}, 'unknown')`;
      // One row per run within each ledger line, so run counts stay distinct
      // when lines are rolled up into agent, provider and tool totals.
      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          tool,
          model: costEvents.model,
          billingType: costEvents.billingType,
          heartbeatRunId: costEvents.heartbeatRunId,
          eventCount: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
          billedCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, month.start),
            lt(costEvents.occurredAt, month.end),
          ),
        )
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          tool,
          costEvents.model,
          costEvents.billingType,
          costEvents.heartbeatRunId,
        );

      const lineMap = new Map<string, { line: CostLedgerLine; runs: Set<string> }>();
      for (const row of rows) {
        const key = JSON.stringify([row.agentId, row.provider, row.biller, row.tool, row.model, row.billingType]);
        let entry = lineMap.get(key);
        if (!entry) {
          const seatPlan = SEAT_PLAN_BILLING_TYPES.has(row.billingType);
          entry = {
            line: {
              agentId: row.agentId,
              agentName: row.agentName ?? null,
              provider: row.provider,
              biller: row.biller,
              tool: row.tool,
              model: row.model,
              billingType: row.billingType,
              seatPlan,
              basis: seatPlan ? "api_equivalent" : "billed",
              runCount: 0,
              eventCount: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              billedCents: 0,
              apiEquivalentCents: null,
              ledgerCents: 0,
              unpricedTokens: 0,
            },
            runs: new Set(),
          };
          lineMap.set(key, entry);
        }
        const { line } = entry;
        line.eventCount += Number(row.eventCount);
        line.inputTokens += Number(row.inputTokens);
        line.cachedInputTokens += Number(row.cachedInputTokens);
        line.outputTokens += Number(row.outputTokens);
        line.billedCents += Number(row.billedCents);
        if (row.heartbeatRunId) entry.runs.add(row.heartbeatRunId);
      }

      const lines: CostLedgerLine[] = [];
      const lineRuns = new Map<CostLedgerLine, Set<string>>();
      for (const { line, runs } of lineMap.values()) {
        line.runCount = runs.size;
        // Pricing is linear in tokens, so pricing the line total equals the sum per event.
        line.apiEquivalentCents = computeApiEquivalentCents(line);
        const tokens = line.inputTokens + line.cachedInputTokens + line.outputTokens;
        if (line.seatPlan) {
          line.ledgerCents = line.apiEquivalentCents ?? 0;
          if (line.apiEquivalentCents === null) line.unpricedTokens = tokens;
        } else {
          line.ledgerCents = line.billedCents;
        }
        lines.push(line);
        lineRuns.set(line, runs);
      }
      lines.sort(
        (a, b) =>
          (a.agentName ?? a.agentId).localeCompare(b.agentName ?? b.agentId) ||
          a.provider.localeCompare(b.provider) ||
          a.tool.localeCompare(b.tool) ||
          a.model.localeCompare(b.model) ||
          a.billingType.localeCompare(b.billingType),
      );

      const byAgent = new Map<string, TotalAccumulator>();
      const byProvider = new Map<string, TotalAccumulator>();
      const byTool = new Map<string, TotalAccumulator>();
      const totals: TotalAccumulator = { total: emptyTotal("total", null), runs: new Set() };
      const bucket = (map: Map<string, TotalAccumulator>, key: string, label: string | null) => {
        let acc = map.get(key);
        if (!acc) {
          acc = { total: emptyTotal(key, label), runs: new Set() };
          map.set(key, acc);
        }
        return acc;
      };
      for (const line of lines) {
        const runs = lineRuns.get(line)!;
        addLine(bucket(byAgent, line.agentId, line.agentName), line, runs);
        addLine(bucket(byProvider, line.provider, null), line, runs);
        addLine(bucket(byTool, line.tool, null), line, runs);
        addLine(totals, line, runs);
      }

      return {
        companyId,
        month: month.month,
        from: month.start.toISOString(),
        to: month.end.toISOString(),
        priceTableCheckedAt: API_PRICE_TABLE_CHECKED_AT,
        lines,
        byAgent: finishTotals(byAgent),
        byProvider: finishTotals(byProvider),
        byTool: finishTotals(byTool),
        totals: { ...totals.total, runCount: totals.runs.size },
      };
    },
  };
}

export const COST_LEDGER_CSV_COLUMNS = [
  "month",
  "row_type",
  "agent_id",
  "agent_name",
  "provider",
  "biller",
  "tool",
  "model",
  "billing_type",
  "seat_plan",
  "cost_basis",
  "runs",
  "events",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "billed_cents",
  "api_equivalent_cents",
  "ledger_cents",
  "unpriced_tokens",
  "price_table_checked_at",
] as const;

const CSV_FORMULA_CHARS = /^[=+\-@\t\r]/;

function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Names are user-controlled: stop spreadsheets from reading them as formulas.
  const safe = CSV_FORMULA_CHARS.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvCents(value: number | null): string {
  if (value === null) return "";
  return value.toFixed(2);
}

/**
 * CSV for one month: every ledger line, then subtotal rows per agent, provider
 * and tool, then the month total. `row_type` tells them apart, and seat-plan
 * lines carry `seat_plan=yes` and `cost_basis=api_equivalent`.
 */
export function costLedgerToCsv(ledger: CostLedger): string {
  const out = [COST_LEDGER_CSV_COLUMNS.join(",")];
  const counts = (row: {
    runCount: number;
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => [row.runCount, row.eventCount, row.inputTokens, row.cachedInputTokens, row.outputTokens].map(String);

  for (const line of ledger.lines) {
    out.push([
      ledger.month,
      "line",
      csvText(line.agentId),
      csvText(line.agentName),
      csvText(line.provider),
      csvText(line.biller),
      csvText(line.tool),
      csvText(line.model),
      csvText(line.billingType),
      line.seatPlan ? "yes" : "no",
      line.basis,
      ...counts(line),
      csvCents(line.billedCents),
      csvCents(line.apiEquivalentCents),
      csvCents(line.ledgerCents),
      String(line.unpricedTokens),
      ledger.priceTableCheckedAt,
    ].join(","));
  }

  const totalRow = (rowType: string, total: CostLedgerTotal, fields: { agentId?: string; agentName?: string | null; provider?: string; tool?: string }) => {
    const basis =
      total.apiEquivalentLedgerCents > 0 && total.billedLedgerCents > 0
        ? "mixed"
        : total.apiEquivalentLedgerCents > 0
          ? "api_equivalent"
          : "billed";
    out.push([
      ledger.month,
      rowType,
      csvText(fields.agentId),
      csvText(fields.agentName),
      csvText(fields.provider),
      "",
      csvText(fields.tool),
      "",
      "",
      "",
      basis,
      ...counts(total),
      csvCents(total.billedCents),
      csvCents(total.apiEquivalentCents),
      csvCents(total.ledgerCents),
      String(total.unpricedTokens),
      ledger.priceTableCheckedAt,
    ].join(","));
  };

  for (const total of ledger.byAgent) totalRow("agent_total", total, { agentId: total.key, agentName: total.label });
  for (const total of ledger.byProvider) totalRow("provider_total", total, { provider: total.key });
  for (const total of ledger.byTool) totalRow("tool_total", total, { tool: total.key });
  totalRow("month_total", ledger.totals, {});

  return `${out.join("\n")}\n`;
}
