import type { ClientJourneyExpectedDeliverable, ClientJourneyStageState } from "./types/client-journey.js";
import type { DeliverableConfidentiality, DeliverableKind, DeliverableStatus } from "./types/deliverable.js";

// The rules behind the client journey by stage (GRE-1473). The server uses
// them to build the portal view and the UI uses them to label each section,
// so the two cannot disagree about which stage is complete.

export interface JourneyStageInput {
  id: string;
  kind: string;
  position: number;
}

/**
 * The state of each stage for one case, in journey order.
 *
 * - Stages before the case's stage are `done`; a `done`-kind stage the case
 *   sits in is `done` too (the journey is finished).
 * - Paused and Lost style stages (kind `cancelled`) are not part of the
 *   journey. When the case sits in one, that stage is `side`, and the stage
 *   the case was in before (`lastJourneyStageId`) decides what is complete:
 *   only the stages before it. The stage it paused in is not complete.
 * - Other cancelled-kind stages are left out.
 */
export function journeyStageStates(
  stages: JourneyStageInput[],
  currentStageId: string | null | undefined,
  lastJourneyStageId?: string | null,
): Array<{ id: string; state: ClientJourneyStageState }> {
  const ordered = [...stages].sort((left, right) => left.position - right.position);
  const journey = ordered.filter((stage) => stage.kind !== "cancelled");
  const currentIndex = journey.findIndex((stage) => stage.id === currentStageId);
  const sideStage = currentIndex < 0 ? ordered.find((stage) => stage.id === currentStageId) ?? null : null;
  const referenceIndex = currentIndex >= 0
    ? currentIndex
    : journey.findIndex((stage) => stage.id === lastJourneyStageId);

  const states = journey.map((stage, index): { id: string; state: ClientJourneyStageState } => {
    if (referenceIndex < 0) return { id: stage.id, state: "next" };
    if (index < referenceIndex) return { id: stage.id, state: "done" };
    if (index === referenceIndex && currentIndex >= 0) {
      return { id: stage.id, state: stage.kind === "done" ? "done" : "current" };
    }
    return { id: stage.id, state: "next" };
  });
  if (sideStage) states.push({ id: sideStage.id, state: "side" });
  return states;
}

/**
 * The portal visibility rule: the client sees a deliverable only when it is
 * marked client-facing, it is final (not a draft), its stage is complete, and
 * its confidentiality lets it out: public always, client only once the case
 * has an accepted NDA, internal never.
 */
export function isClientPortalVisible(input: {
  clientFacing: boolean;
  status: DeliverableStatus;
  stageState: ClientJourneyStageState | null | undefined;
  confidentiality: DeliverableConfidentiality;
  ndaAccepted: boolean;
}): boolean {
  if (!input.clientFacing || input.status !== "final" || input.stageState !== "done") return false;
  return input.confidentiality === "public" || (input.confidentiality === "client" && input.ndaAccepted);
}

/**
 * Expected against filed for one stage. A filed deliverable meets an expected
 * entry when its key matches, or else its title (ignoring case and spacing).
 * Each filed deliverable meets at most one entry, and key matches are taken
 * first so a title match never steals one another entry names by key.
 */
export function stageCompleteness(
  expected: Array<{ key: string; title: string; kind?: DeliverableKind | null }>,
  filed: Array<{ id: string; key: string; title: string }>,
): ClientJourneyExpectedDeliverable[] {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const used = new Set<string>();
  const take = (match: (item: { id: string; key: string; title: string }) => boolean) => {
    const found = filed.find((item) => !used.has(item.id) && match(item));
    if (found) used.add(found.id);
    return found?.id ?? null;
  };
  const byKey = expected.map((entry) => take((item) => item.key === entry.key));
  return expected.map((entry, index) => ({
    key: entry.key,
    title: entry.title,
    kind: entry.kind ?? null,
    deliverableId: byKey[index] ?? take((item) => norm(item.title) === norm(entry.title)),
  }));
}
