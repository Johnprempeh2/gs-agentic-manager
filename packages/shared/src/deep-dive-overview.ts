import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_KNOWLEDGE,
  DEEP_DIVE_STREAMS,
  type DeepDiveDepth,
  type DeepDiveGifKey,
  type DeepDiveKnowledge,
  type DeepDiveStreamFields,
  type DeepDiveStreamKey,
  type DeepDiveStreamStatus,
} from "./deep-dive.js";
import { DEEP_DIVE_FINDING_STATUSES, type DeepDiveFindingStatus } from "./deep-dive-findings.js";
import type { DeepDiveSessionSummary } from "./deep-dive-sessions.js";

/**
 * Deep Dive overview (GRE-2372): Screen 1 of the GRE-2327 plan, from the
 * Indago control centre and the website overview. It holds no data of its
 * own: the server reads the streams, findings, sessions, files, boards,
 * opportunities and traceability chain, and deepDiveOverview turns them into
 * "what is next", progress by stream, the next session, the open findings and
 * the work that only a person can do. The order follows Book V: place the
 * known, validate the indicated, investigate only the unknown.
 */

export const DEEP_DIVE_NEXT_STEP_KEYS = [
  "start_record",
  "continue_session",
  "decide_findings",
  "unblock_streams",
  "record_north_star",
  "choose_client",
  "validate_indicated",
  "start_session",
  "chase_documents",
  "plan_session",
  "find_opportunities",
  "fix_broken_links",
  "place_people",
] as const;
export type DeepDiveNextStepKey = (typeof DEEP_DIVE_NEXT_STEP_KEYS)[number];

export interface DeepDiveNextStep {
  key: DeepDiveNextStepKey;
  title: string;
  detail: string;
  /** How many items the step covers. */
  count: number;
  /** The screen where the step is done, as an app path. */
  href: string;
  /** Only a person can do it: an agent may not validate, set Known, unblock or choose. */
  needsPerson: boolean;
}

/** What the server reads for the overview. Every field comes from a model of steps 1–7. */
export interface DeepDiveOverviewInput {
  now: Date;
  /** False until the Deep Dive record case exists. */
  recordExists: boolean;
  /** The North Star's own words, without headings or the stub prompt; empty when not recorded. */
  northStarWords: string;
  /** True once a person has chosen the client the record is about. */
  clientChosen: boolean;
  /** Stream cases that exist, with their fields read through readDeepDiveStreamFields. */
  streams: { caseId: string; fields: DeepDiveStreamFields }[];
  findings: {
    id: string;
    statement: string;
    status: DeepDiveFindingStatus;
    streamCaseId: string;
    gifKey: DeepDiveGifKey;
    createdAt: string;
  }[];
  sessions: DeepDiveSessionSummary[];
  /** Documents asked of the client; held once a file met the request. */
  documentRequests: { id: string; title: string; held: boolean }[];
  /** Validated findings that at least one opportunity rests on. */
  findingIdsInOpportunities: string[];
  /** Broken links in the traceability chain, not counting a missing North Star (it has its own step). */
  brokenLinkCount: number;
  unplacedPeopleCount: number;
}

export interface DeepDiveStreamProgress {
  key: DeepDiveStreamKey;
  label: string;
  /** Null while the stream case does not exist yet. */
  caseId: string | null;
  status: DeepDiveStreamStatus;
  depth: DeepDiveDepth;
  depthReason: string;
  cells: Record<DeepDiveKnowledge, number>;
  findings: { validated: number; proposed: number };
}

export interface DeepDiveOpenFinding {
  id: string;
  statement: string;
  streamKey: DeepDiveStreamKey | null;
  gifKey: DeepDiveGifKey;
  createdAt: string;
}

/** GET /api/companies/:companyId/deep-dive/overview */
export interface DeepDiveOverview {
  companyId: string;
  /** Every step in order; the first is what is next. Empty when nothing waits. */
  next: DeepDiveNextStep[];
  /** The steps of `next` that only a person can do, in the same order. */
  needsPerson: DeepDiveNextStep[];
  streams: DeepDiveStreamProgress[];
  /** All 45 GIF cells (9 streams x 5 questions) by Known / Indicated / Unknown. */
  cells: Record<DeepDiveKnowledge, number>;
  nextSession: DeepDiveSessionSummary | null;
  /** Proposed findings waiting for a person's decision, oldest first. */
  openFindings: DeepDiveOpenFinding[];
  findingCounts: Record<DeepDiveFindingStatus, number>;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function zeroCells(): Record<DeepDiveKnowledge, number> {
  return Object.fromEntries(DEEP_DIVE_KNOWLEDGE.map((k) => [k, 0])) as Record<DeepDiveKnowledge, number>;
}

/**
 * The session to run next: a live one first, else the planned one with the
 * earliest date, else the oldest planned one with no date. Closed sessions never.
 */
export function deepDiveNextSession<T extends DeepDiveSessionSummary>(sessions: readonly T[]): T | null {
  const live = sessions
    .filter((s) => s.status === "live")
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));
  if (live[0]) return live[0];
  const planned = sessions.filter((s) => s.status === "planned");
  const dated = planned
    .filter((s) => s.plannedFor)
    .sort((a, b) => Date.parse(a.plannedFor!) - Date.parse(b.plannedFor!));
  if (dated[0]) return dated[0];
  return [...planned].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Progress of the nine streams in Book V order, a missing stream shown as not started. */
export function deepDiveStreamProgress(input: Pick<DeepDiveOverviewInput, "streams" | "findings">): DeepDiveStreamProgress[] {
  return DEEP_DIVE_STREAMS.map((stream) => {
    const found = input.streams.find((s) => s.fields.stream === stream.key) ?? null;
    const cells = zeroCells();
    for (const gif of DEEP_DIVE_GIF) cells[found?.fields.knowledge[gif.key] ?? "unknown"] += 1;
    const findings = found ? input.findings.filter((f) => f.streamCaseId === found.caseId) : [];
    return {
      key: stream.key,
      label: stream.label,
      caseId: found?.caseId ?? null,
      status: found?.fields.status ?? "not_started",
      depth: found?.fields.depth ?? "full",
      depthReason: found?.fields.depthReason ?? "",
      cells,
      findings: {
        validated: findings.filter((f) => f.status === "validated").length,
        proposed: findings.filter((f) => f.status === "proposed").length,
      },
    };
  });
}

/** Every step that waits, in order. The first is what is next. */
export function deepDiveNextSteps(input: DeepDiveOverviewInput): DeepDiveNextStep[] {
  if (!input.recordExists) {
    return [{
      key: "start_record",
      title: "Start the Deep Dive record",
      detail: "Create the record and its nine Investigation Streams before anything else.",
      count: 1,
      href: "/deep-dive",
      needsPerson: false,
    }];
  }

  const steps: DeepDiveNextStep[] = [];
  const add = (step: DeepDiveNextStep) => steps.push(step);
  const progress = deepDiveStreamProgress(input);

  const live = input.sessions.filter((s) => s.status === "live");
  if (live.length) {
    const session = deepDiveNextSession(live)!;
    add({
      key: "continue_session",
      title: `Continue the live session "${session.title}"`,
      detail: `${session.answeredCount} of ${plural(session.questionCount, "question")} answered.`,
      count: live.length,
      href: `/deep-dive/sessions/${session.id}`,
      needsPerson: false,
    });
  }

  const proposed = input.findings.filter((f) => f.status === "proposed");
  if (proposed.length) {
    add({
      key: "decide_findings",
      title: `Decide ${plural(proposed.length, "proposed finding")}`,
      detail: "Validate or reject each one. Only a person validates a finding.",
      count: proposed.length,
      href: "/deep-dive/findings",
      needsPerson: true,
    });
  }

  const blocked = progress.filter((s) => s.status === "blocked");
  if (blocked.length) {
    add({
      key: "unblock_streams",
      title: `Unblock ${plural(blocked.length, "stream")}`,
      detail: blocked.map((s) => s.label).join(", "),
      count: blocked.length,
      href: "/deep-dive",
      needsPerson: true,
    });
  }

  if (!input.northStarWords.trim()) {
    add({
      key: "record_north_star",
      title: "Record the North Star",
      detail: "The chief executive's words, who said them and when. Every chain starts here.",
      count: 1,
      href: "/deep-dive",
      needsPerson: true,
    });
  }

  if (!input.clientChosen) {
    add({
      key: "choose_client",
      title: "Choose the client",
      detail: "Name the client this Deep Dive is about, so its files and requests can be linked.",
      count: 1,
      href: "/deep-dive/files",
      needsPerson: true,
    });
  }

  const indicated = progress.reduce((sum, s) => sum + s.cells.indicated, 0);
  if (indicated) {
    add({
      key: "validate_indicated",
      title: `Validate ${plural(indicated, "indicated cell")}`,
      detail: "Confirm what is indicated before you investigate further. Only a person sets Known.",
      count: indicated,
      href: "/deep-dive",
      needsPerson: true,
    });
  }

  const due = input.sessions.filter(
    (s) => s.status === "planned" && s.plannedFor && Date.parse(s.plannedFor) <= input.now.getTime(),
  );
  if (due.length && !live.length) {
    const session = deepDiveNextSession(due)!;
    add({
      key: "start_session",
      title: `Start the session "${session.title}"`,
      detail: due.length === 1 ? "It was planned for now or earlier." : `${plural(due.length, "planned session")} are due.`,
      count: due.length,
      href: `/deep-dive/sessions/${session.id}`,
      needsPerson: false,
    });
  }

  const missing = input.documentRequests.filter((r) => !r.held);
  if (missing.length) {
    add({
      key: "chase_documents",
      title: `Chase ${plural(missing.length, "document")} asked of the client`,
      detail: missing.slice(0, 3).map((r) => r.title).join(", ") + (missing.length > 3 ? ", and more" : ""),
      count: missing.length,
      href: "/deep-dive/files",
      needsPerson: false,
    });
  }

  const unknown = progress.reduce((sum, s) => sum + s.cells.unknown, 0);
  const sessionAhead = input.sessions.some((s) => s.status === "planned" || s.status === "live");
  if (unknown && !sessionAhead) {
    add({
      key: "plan_session",
      title: "Plan a session for the unknown",
      detail: `${plural(unknown, "cell")} of 45 ${unknown === 1 ? "is" : "are"} still Unknown, and no session is planned.`,
      count: unknown,
      href: "/deep-dive/sessions",
      needsPerson: false,
    });
  }

  const inOpportunity = new Set(input.findingIdsInOpportunities);
  const loose = input.findings.filter((f) => f.status === "validated" && !inOpportunity.has(f.id));
  if (loose.length) {
    add({
      key: "find_opportunities",
      title: `Place ${plural(loose.length, "validated finding")} on an opportunity`,
      detail: "No opportunity rests on them yet.",
      count: loose.length,
      href: "/deep-dive/opportunities",
      needsPerson: false,
    });
  }

  if (input.brokenLinkCount) {
    add({
      key: "fix_broken_links",
      title: `Fix ${plural(input.brokenLinkCount, "broken link")} in the chain`,
      detail: "North Star → Source → Finding → Opportunity → Design → Commercial → Roadmap → KPI.",
      count: input.brokenLinkCount,
      href: "/deep-dive/traceability",
      needsPerson: false,
    });
  }

  if (input.unplacedPeopleCount) {
    add({
      key: "place_people",
      title: `Place ${plural(input.unplacedPeopleCount, "person", "people")} on the organisation board`,
      detail: "They are in no unit yet.",
      count: input.unplacedPeopleCount,
      href: "/deep-dive/organisation",
      needsPerson: false,
    });
  }

  return steps;
}

export function deepDiveOverview(companyId: string, input: DeepDiveOverviewInput): DeepDiveOverview {
  const next = deepDiveNextSteps(input);
  const streams = deepDiveStreamProgress(input);
  const cells = zeroCells();
  for (const stream of streams) for (const k of DEEP_DIVE_KNOWLEDGE) cells[k] += stream.cells[k];
  const streamKeyOf = new Map(input.streams.map((s) => [s.caseId, s.fields.stream]));
  const findingCounts = Object.fromEntries(
    DEEP_DIVE_FINDING_STATUSES.map((status) => [status, input.findings.filter((f) => f.status === status).length]),
  ) as Record<DeepDiveFindingStatus, number>;
  return {
    companyId,
    next,
    needsPerson: next.filter((step) => step.needsPerson),
    streams,
    cells,
    nextSession: deepDiveNextSession(input.sessions),
    openFindings: input.findings
      .filter((f) => f.status === "proposed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((f) => ({
        id: f.id,
        statement: f.statement,
        streamKey: streamKeyOf.get(f.streamCaseId) ?? null,
        gifKey: f.gifKey,
        createdAt: f.createdAt,
      })),
    findingCounts,
  };
}
