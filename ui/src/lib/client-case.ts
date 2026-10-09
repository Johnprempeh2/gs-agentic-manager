import type { PipelineCaseEvent, PipelineStage } from "../api/pipelines";

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
    owner: readFirst(source, ["ownerPerson", "owner", "owners"]),
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
