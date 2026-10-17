import type { PipelineCaseEvent, PipelineStage } from "../api/pipelines";
import { formatNumber } from "./utils";

/** Pipeline key of the "Client journey" pipeline; its cases have type `client`. */
export const CLIENT_CASE_TYPE = "client";

const DAY_MS = 24 * 60 * 60 * 1000;

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFirst(fields: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readText(fields[key]);
    if (value) return value;
  }
  return null;
}

/** Whole days since `enteredAt`, never negative. */
export function daysInStage(enteredAt: Date | string | null | undefined, now: Date = new Date()) {
  if (!enteredAt) return null;
  const time = new Date(enteredAt).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

export function formatDaysInStage(days: number | null) {
  if (days == null) return null;
  if (days === 0) return "In stage today";
  return days === 1 ? "1 day in stage" : `${days} days in stage`;
}

export type StageStripStep = {
  id: string;
  name: string;
  state: "done" | "current" | "next";
};

/**
 * The journey as a strip: every stage except Paused/Lost-style stages
 * (kind `cancelled`), in order. When the case sits in one of those, the strip
 * still shows the journey and the caller shows the side state on its own.
 */
export function buildStageStrip(stages: PipelineStage[], currentStageId: string | null | undefined) {
  const ordered = [...stages].sort((left, right) => left.position - right.position);
  const journey = ordered.filter((stage) => stage.kind !== "cancelled");
  const currentIndex = journey.findIndex((stage) => stage.id === currentStageId);
  const steps: StageStripStep[] = journey.map((stage, index) => ({
    id: stage.id,
    name: stage.name,
    state: index === currentIndex ? "current" : currentIndex >= 0 && index < currentIndex ? "done" : "next",
  }));
  const sideStage = currentIndex < 0 ? ordered.find((stage) => stage.id === currentStageId) ?? null : null;
  return { steps, sideStage };
}

export type ClientRecord = {
  country: string | null;
  owner: string | null;
  leadAgent: string | null;
  nextAction: string | null;
  nextActionOwner: string | null;
  nextActionDate: string | null;
  lastContact: string | null;
  lastContactNote: string | null;
};

/** The client record fields John set out on GRE-1044 (country, owners, next action, last contact). */
export function readClientRecord(fields: Record<string, unknown> | null | undefined): ClientRecord {
  const source = fields ?? {};
  return {
    country: readFirst(source, ["country"]),
    // "dealOwner" is the deal owner a Pipedrive or HubSpot export import brings in.
    owner: readFirst(source, ["ownerPerson", "owner", "owners", "dealOwner"]),
    leadAgent: readFirst(source, ["leadAgent"]),
    nextAction: readFirst(source, ["nextAction"]),
    nextActionOwner: readFirst(source, ["nextActionOwner"]),
    nextActionDate: readFirst(source, ["nextActionDate"]),
    lastContact: readFirst(source, ["lastContact"]),
    lastContactNote: readFirst(source, ["lastContactNote"]),
  };
}

/** The keys `readClientRecord` shows, so the generic details list can skip them. */
export const CLIENT_RECORD_FIELD_KEYS = new Set([
  "country",
  "ownerPerson",
  "owner",
  "owners",
  "dealOwner",
  "leadAgent",
  "nextAction",
  "nextActionOwner",
  "nextActionDate",
  "lastContact",
  "lastContactNote",
  "contacts",
]);

/** Owner and next action for a board card. Empty for cases that do not use these fields. */
export function readCardSummary(fields: Record<string, unknown> | null | undefined) {
  const record = readClientRecord(fields);
  return { owner: record.owner, nextAction: record.nextAction };
}

export type StageHistoryEntry = {
  id: string;
  stageName: string;
  at: Date | string;
  forced: boolean;
};

/** Each stage the case entered, oldest first. */
export function buildStageHistory(
  events: PipelineCaseEvent[],
  stages: PipelineStage[],
): StageHistoryEntry[] {
  const nameById = new Map(stages.map((stage) => [stage.id, stage.name]));
  return events
    .filter((event) =>
      event.toStageId &&
      (event.type === "ingested" || event.type === "transitioned" || event.type === "transition_forced"),
    )
    .map((event) => ({
      id: event.id,
      stageName: event.toStage?.name ?? nameById.get(event.toStageId!) ?? "Unknown stage",
      at: event.createdAt,
      forced: event.type === "transition_forced",
    }));
}

// DevTools clients (John, 16 Oct): the deals imported from Pipedrive came
// through the DevTools journey, not the DX journey, so each Pipedrive pipeline
// (key `pipedrive-<id>`) and the Pipedrive leads inbox (`pipedrive-leads`) gets
// a client page of its own: the deal, its people and its history, without the
// DX steps (NDA, engagement pack, deliverables by stage, portal).

export const DEVTOOLS_CASE_TYPE_PREFIX = "pipedrive-";

export function isDevtoolsCaseType(caseType: string | null | undefined) {
  return typeof caseType === "string" && caseType.startsWith(DEVTOOLS_CASE_TYPE_PREFIX);
}

/** Deal fields the DevTools client page shows in its "Deal" section. */
export const DEVTOOLS_DEAL_FIELD_KEYS = new Set([
  "dealStatus",
  "dealValue",
  "dealCurrency",
  "dealOwner",
  "expectedCloseDate",
  "probability",
  "nextActivityDate",
  "lastActivityDate",
  "nextActivitySubject",
  "lastActivitySubject",
  "lastActivityNote",
  "lostReason",
  "wonOn",
  "lostOn",
  "leadValue",
  "leadCurrency",
  "leadOwner",
]);

export interface DevtoolsDeal {
  status: string | null;
  value: number | null;
  currency: string | null;
  owner: string | null;
  expectedClose: string | null;
  probability: number | null;
  nextActivity: string | null;
  lastActivity: string | null;
  lostReason: string | null;
  closedOn: string | null;
}

function fieldText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function fieldNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function readDevtoolsDeal(fields: Record<string, unknown> | null | undefined): DevtoolsDeal {
  const record = fields ?? {};
  const status = fieldText(record.dealStatus);
  return {
    status,
    value: fieldNumber(record.dealValue) ?? fieldNumber(record.leadValue),
    currency: fieldText(record.dealCurrency) ?? fieldText(record.leadCurrency),
    owner: fieldText(record.dealOwner) ?? fieldText(record.leadOwner) ?? fieldText(record.ownerPerson) ?? fieldText(record.owner),
    expectedClose: fieldText(record.expectedCloseDate),
    probability: fieldNumber(record.probability),
    nextActivity: fieldText(record.nextActivityDate),
    lastActivity: fieldText(record.lastActivityDate),
    lostReason: fieldText(record.lostReason),
    closedOn: status?.toLowerCase() === "won" ? fieldText(record.wonOn) : status?.toLowerCase() === "lost" ? fieldText(record.lostOn) : null,
  };
}

/** Deal value of one case, from a Pipedrive deal or lead; null when it has none. */
export function caseDealValue(fields: Record<string, unknown> | null | undefined) {
  const deal = readDevtoolsDeal(fields);
  return deal.value == null ? null : { value: deal.value, currency: deal.currency ?? "" };
}

/** Deal values summed per currency, largest first, as Pipedrive shows under each stage. */
export function sumDealValues(cases: Array<{ fields?: Record<string, unknown> | null }>) {
  const totals = new Map<string, number>();
  for (const item of cases) {
    const deal = caseDealValue(item.fields);
    if (!deal) continue;
    totals.set(deal.currency, (totals.get(deal.currency) ?? 0) + deal.value);
  }
  return [...totals.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
}

export function formatDealTotals(totals: Array<{ currency: string; total: number }>) {
  return totals
    .map(({ currency, total }) => `${formatNumber(total, { maximumFractionDigits: 0 })}${currency ? ` ${currency}` : ""}`)
    .join(" + ");
}

/** Deals won or lost in the calendar month of `now` (UTC), with their values per currency. */
export function dealsClosedThisMonth(
  cases: Array<{ fields?: Record<string, unknown> | null }>,
  outcome: "won" | "lost",
  now: Date = new Date(),
) {
  const closed = cases.filter((item) => {
    const deal = readDevtoolsDeal(item.fields);
    if (deal.status?.trim().toLowerCase() !== outcome || !deal.closedOn) return false;
    const closedOn = new Date(deal.closedOn);
    return (
      !Number.isNaN(closedOn.getTime()) &&
      closedOn.getUTCFullYear() === now.getUTCFullYear() &&
      closedOn.getUTCMonth() === now.getUTCMonth()
    );
  });
  return { count: closed.length, totals: sumDealValues(closed) };
}

/**
 * Open deal value weighted by each deal's probability, per currency, largest
 * first: Pipedrive's "weighted value". Deals without a probability are left
 * out, so the figure never overstates the forecast.
 */
export function weightedDealValues(cases: Array<{ fields?: Record<string, unknown> | null }>) {
  const totals = new Map<string, number>();
  for (const item of cases) {
    const deal = readDevtoolsDeal(item.fields);
    if (deal.value == null || deal.probability == null) continue;
    const currency = deal.currency ?? "";
    totals.set(currency, (totals.get(currency) ?? 0) + (deal.value * Math.min(100, Math.max(0, deal.probability))) / 100);
  }
  return [...totals.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
}

export type ForecastBucket = {
  key: string;
  label: string;
  count: number;
  totals: Array<{ currency: string; total: number }>;
  weighted: Array<{ currency: string; total: number }>;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Pipedrive's forecast view for open deals: value and weighted value by the
 * month each deal is expected to close. Deals expected before this month go
 * under "Overdue", after the last month shown under "Later", and deals with
 * no close date under "No close date". Won, lost and deleted deals are left out.
 */
export function forecastByCloseMonth(
  cases: Array<{ fields?: Record<string, unknown> | null }>,
  now: Date = new Date(),
  months = 3,
): ForecastBucket[] {
  const monthKeys: string[] = [];
  for (let offset = 0; offset < months; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    monthKeys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const groups = new Map<string, Array<{ fields?: Record<string, unknown> | null }>>();
  for (const item of cases) {
    const deal = readDevtoolsDeal(item.fields);
    if (deal.value == null) continue;
    if (deal.status && deal.status.toLowerCase() !== "open") continue;
    const month = deal.expectedClose && /^\d{4}-\d{2}/.test(deal.expectedClose) ? deal.expectedClose.slice(0, 7) : null;
    const key = !month ? "none" : month < monthKeys[0]! ? "overdue" : monthKeys.includes(month) ? month : "later";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const label = (key: string) => {
    if (key === "overdue") return "Overdue";
    if (key === "later") return "Later";
    if (key === "none") return "No close date";
    const [year, month] = key.split("-");
    return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
  };
  return ["overdue", ...monthKeys, "later", "none"]
    .filter((key) => groups.has(key) || monthKeys.includes(key))
    .map((key) => {
      const items = groups.get(key) ?? [];
      return { key, label: label(key), count: items.length, totals: sumDealValues(items), weighted: weightedDealValues(items) };
    });
}

/**
 * Pipedrive's win rate: deals won out of deals won or lost in the last `days`
 * days, by their won or lost date. Null when none closed in that window.
 */
export function dealWinRate(cases: Array<{ fields?: Record<string, unknown> | null }>, now: Date = new Date(), days = 90) {
  const since = now.getTime() - days * DAY_MS;
  let won = 0;
  let lost = 0;
  for (const item of cases) {
    const deal = readDevtoolsDeal(item.fields);
    const status = deal.status?.trim().toLowerCase();
    if ((status !== "won" && status !== "lost") || !deal.closedOn) continue;
    const time = new Date(deal.closedOn).getTime();
    if (!Number.isFinite(time) || time < since || time > now.getTime() + DAY_MS) continue;
    if (status === "won") won += 1;
    else lost += 1;
  }
  return won + lost === 0 ? null : { won, lost, percent: Math.round((won / (won + lost)) * 100) };
}

/** Average whole days the cases have been in their stage; null when none has a date. */
export function averageDaysInStage(cases: Array<{ stageEnteredAt?: Date | string | null }>, now: Date = new Date()) {
  const days = cases.map((item) => daysInStage(item.stageEnteredAt, now)).filter((value): value is number => value != null);
  return days.length === 0 ? null : Math.round(days.reduce((sum, value) => sum + value, 0) / days.length);
}
