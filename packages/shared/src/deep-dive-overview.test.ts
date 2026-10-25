import { describe, expect, it } from "vitest";
import { DEEP_DIVE_STREAMS, defaultDeepDiveStreamFields, type DeepDiveStreamFields } from "./deep-dive.js";
import type { DeepDiveSessionSummary } from "./deep-dive-sessions.js";
import {
  deepDiveNextSession,
  deepDiveNextSteps,
  deepDiveOverview,
  type DeepDiveOverviewInput,
} from "./deep-dive-overview.js";

const NOW = new Date("2026-10-25T12:00:00Z");

/** Every stream examined, every cell Known: nothing waits. */
function knownStream(index: number): { caseId: string; fields: DeepDiveStreamFields } {
  const stream = DEEP_DIVE_STREAMS[index]!;
  const fields = defaultDeepDiveStreamFields(stream.key);
  for (const key of Object.keys(fields.knowledge) as (keyof typeof fields.knowledge)[]) fields.knowledge[key] = "known";
  return { caseId: `case-${stream.key}`, fields: { ...fields, status: "examined" } };
}

function settled(): DeepDiveOverviewInput {
  return {
    now: NOW,
    recordExists: true,
    northStarWords: "Same-day quotes for every customer",
    clientChosen: true,
    streams: DEEP_DIVE_STREAMS.map((_, i) => knownStream(i)),
    findings: [],
    sessions: [],
    documentRequests: [],
    findingIdsInOpportunities: [],
    brokenLinkCount: 0,
    unplacedPeopleCount: 0,
  };
}

function session(overrides: Partial<DeepDiveSessionSummary>): DeepDiveSessionSummary {
  return {
    id: "s",
    companyId: "co",
    title: "Session",
    status: "planned",
    visibility: "internal",
    plannedFor: null,
    startedAt: null,
    closedAt: null,
    createdAt: "2026-10-20T09:00:00Z",
    questionCount: 4,
    answeredCount: 0,
    ...overrides,
  };
}

const finding = (id: string, status: "proposed" | "validated" | "rejected" | "superseded", createdAt = "2026-10-21T09:00:00Z") => ({
  id,
  statement: `Finding ${id}`,
  status,
  streamCaseId: "case-leadership",
  gifKey: "current-state" as const,
  createdAt,
});

const keys = (input: DeepDiveOverviewInput) => deepDiveNextSteps(input).map((s) => s.key);

describe("deepDiveNextSteps", () => {
  it("has nothing next when every stream is known and every link is whole", () => {
    expect(deepDiveNextSteps(settled())).toEqual([]);
  });

  it("asks only to start the record when there is none", () => {
    const input = { ...settled(), recordExists: false, findings: [finding("f", "proposed")] };
    expect(keys(input)).toEqual(["start_record"]);
  });

  it("puts a live session first, then the work only a person can do", () => {
    const input: DeepDiveOverviewInput = {
      ...settled(),
      sessions: [session({ id: "live", title: "CFO interview", status: "live", startedAt: "2026-10-25T10:00:00Z", answeredCount: 1 })],
      findings: [finding("f", "proposed")],
      northStarWords: "",
    };
    const steps = deepDiveNextSteps(input);
    expect(steps.map((s) => s.key)).toEqual(["continue_session", "decide_findings", "record_north_star"]);
    expect(steps[0]).toMatchObject({ href: "/deep-dive/sessions/live", needsPerson: false, detail: "1 of 4 questions answered." });
    expect(steps[1]).toMatchObject({ title: "Decide 1 proposed finding", needsPerson: true });
  });

  it("validates the indicated before it investigates the unknown (Book V)", () => {
    const input = settled();
    input.streams[0]!.fields.knowledge["current-state"] = "indicated";
    input.streams[1]!.fields.knowledge.evidence = "unknown";
    expect(keys(input)).toEqual(["validate_indicated", "plan_session"]);
    const [indicated, unknown] = deepDiveNextSteps(input);
    expect(indicated).toMatchObject({ count: 1, needsPerson: true });
    expect(unknown).toMatchObject({ count: 1, detail: "1 cell of 45 is still Unknown, and no session is planned." });
  });

  it("counts a missing stream as five Unknown cells", () => {
    const input = { ...settled(), streams: settled().streams.slice(1) };
    expect(deepDiveNextSteps(input)).toEqual([expect.objectContaining({ key: "plan_session", count: 5 })]);
  });

  it("does not ask to plan a session when one is already planned", () => {
    const input = { ...settled(), streams: settled().streams.slice(1), sessions: [session({ plannedFor: "2026-11-01T09:00:00Z" })] };
    expect(keys(input)).toEqual([]);
  });

  it("asks to start a planned session once its time has come, unless one is live", () => {
    const due = session({ id: "due", title: "Ops walk-through", plannedFor: "2026-10-25T11:00:00Z" });
    expect(deepDiveNextSteps({ ...settled(), sessions: [due] })[0]).toMatchObject({
      key: "start_session",
      href: "/deep-dive/sessions/due",
    });
    const live = session({ id: "live", status: "live", startedAt: "2026-10-25T10:00:00Z" });
    expect(keys({ ...settled(), sessions: [due, live] })).toEqual(["continue_session"]);
  });

  it("names blocked streams and marks them for a person", () => {
    const input = settled();
    input.streams[3]!.fields.status = "blocked";
    expect(deepDiveNextSteps(input)).toEqual([
      expect.objectContaining({ key: "unblock_streams", detail: "People", needsPerson: true }),
    ]);
  });

  it("asks a person to choose the client", () => {
    expect(deepDiveNextSteps({ ...settled(), clientChosen: false })).toEqual([
      expect.objectContaining({ key: "choose_client", href: "/deep-dive/files", needsPerson: true }),
    ]);
  });

  it("chases only the documents not yet held", () => {
    const input = {
      ...settled(),
      documentRequests: [
        { id: "a", title: "Org chart", held: true },
        { id: "b", title: "Quote log", held: false },
      ],
    };
    expect(deepDiveNextSteps(input)).toEqual([
      expect.objectContaining({ key: "chase_documents", count: 1, detail: "Quote log", needsPerson: false }),
    ]);
  });

  it("asks to place validated findings no opportunity rests on, ignoring other statuses", () => {
    const input = {
      ...settled(),
      findings: [finding("a", "validated"), finding("b", "validated"), finding("c", "rejected"), finding("d", "superseded")],
      findingIdsInOpportunities: ["a"],
    };
    expect(deepDiveNextSteps(input)).toEqual([expect.objectContaining({ key: "find_opportunities", count: 1 })]);
  });

  it("ends with broken links, then people to place", () => {
    const input = { ...settled(), brokenLinkCount: 3, unplacedPeopleCount: 1 };
    expect(deepDiveNextSteps(input)).toEqual([
      expect.objectContaining({ key: "fix_broken_links", title: "Fix 3 broken links in the chain" }),
      expect.objectContaining({ key: "place_people", title: "Place 1 person on the organisation board" }),
    ]);
  });
});

describe("deepDiveNextSession", () => {
  it("prefers a live session, then the earliest dated, then the oldest undated, never a closed one", () => {
    const undated = session({ id: "undated", createdAt: "2026-10-01T09:00:00Z" });
    const later = session({ id: "later", plannedFor: "2026-11-10T09:00:00Z" });
    const sooner = session({ id: "sooner", plannedFor: "2026-11-02T09:00:00Z" });
    const closed = session({ id: "closed", status: "closed", plannedFor: "2026-10-01T09:00:00Z" });
    const live = session({ id: "live", status: "live", startedAt: "2026-10-25T10:00:00Z" });
    expect(deepDiveNextSession([undated, later, sooner, closed, live])?.id).toBe("live");
    expect(deepDiveNextSession([undated, later, sooner, closed])?.id).toBe("sooner");
    expect(deepDiveNextSession([undated, closed])?.id).toBe("undated");
    expect(deepDiveNextSession([closed])).toBeNull();
  });
});

describe("deepDiveOverview", () => {
  it("sums progress by stream and lists open findings oldest first", () => {
    const input = settled();
    input.streams[0]!.fields.knowledge.evidence = "indicated";
    input.findings = [finding("new", "proposed", "2026-10-24T09:00:00Z"), finding("old", "proposed"), finding("v", "validated")];
    input.findingIdsInOpportunities = ["v"];
    const overview = deepDiveOverview("co", input);

    expect(overview.cells).toEqual({ known: 44, indicated: 1, unknown: 0 });
    expect(overview.streams).toHaveLength(9);
    expect(overview.streams[0]).toMatchObject({
      key: "leadership",
      status: "examined",
      cells: { known: 4, indicated: 1, unknown: 0 },
      findings: { validated: 1, proposed: 2 },
    });
    expect(overview.openFindings.map((f) => f.id)).toEqual(["old", "new"]);
    expect(overview.openFindings[0]!.streamKey).toBe("leadership");
    expect(overview.findingCounts).toEqual({ proposed: 2, validated: 1, rejected: 0, superseded: 0 });
    expect(overview.needsPerson.map((s) => s.key)).toEqual(["decide_findings", "validate_indicated"]);
  });
});
