import { describe, expect, it } from "vitest";
import {
  buildEngagementTimeline,
  canMoveClientPublication,
  clientPublicationGates,
  clientSafeEngagementTimeline,
  deliverableFingerprintSource,
  submitClientPublicationSchema,
  type EngagementTimelineInput,
} from "./client-deliverable-publishing.js";

describe("client publication moves", () => {
  it("publishes only an approved deliverable and accepts only a published one", () => {
    expect(canMoveClientPublication("approved", "publish")).toBe(true);
    for (const status of ["draft", "pending_approval", "published", "accepted", "withdrawn"] as const) {
      expect(canMoveClientPublication(status, "publish")).toBe(false);
    }
    expect(canMoveClientPublication("published", "accept")).toBe(true);
    expect(canMoveClientPublication("approved", "accept")).toBe(false);
  });

  it("approves only what is waiting, and never withdraws an accepted deliverable", () => {
    expect(canMoveClientPublication("pending_approval", "approve")).toBe(true);
    expect(canMoveClientPublication("draft", "approve")).toBe(false);
    expect(canMoveClientPublication("accepted", "withdraw")).toBe(false);
    expect(canMoveClientPublication("withdrawn", "withdraw")).toBe(false);
  });

  it("asks for an approver on submit", () => {
    expect(submitClientPublicationSchema.safeParse({}).success).toBe(false);
    expect(submitClientPublicationSchema.safeParse({ approverUserId: "user-1" }).success).toBe(true);
  });
});

describe("client publication gates", () => {
  it("needs the NDA cleared and the engagement accepted", () => {
    expect(clientPublicationGates({ ndaStatus: "required", engagementStatus: "sent" })).toEqual([
      "nda_required",
      "engagement_not_accepted",
    ]);
    expect(clientPublicationGates({ ndaStatus: "suspended", engagementStatus: "accepted" })).toEqual([]);
    expect(clientPublicationGates({ ndaStatus: "accepted", engagementStatus: "accepted" })).toEqual([]);
  });
});

describe("deliverable fingerprint source", () => {
  it("names a file by its bytes and type, and a link by its address", () => {
    const file = deliverableFingerprintSource({ external: false, url: null, sha256: "abc", contentType: "text/HTML" });
    expect(file).toBe("gsam-deliverable/v1\nfile\nabc\ntext/html");
    expect(deliverableFingerprintSource({ external: false, url: null, sha256: "abd", contentType: "text/html" })).not.toBe(file);
    expect(deliverableFingerprintSource({ external: true, url: "https://example.com/a", sha256: null, contentType: null }))
      .toBe("gsam-deliverable/v1\nlink\nhttps://example.com/a");
    expect(deliverableFingerprintSource({ external: false, url: null, sha256: null, contentType: null })).toBeNull();
  });
});

describe("engagement timeline", () => {
  const base: EngagementTimelineInput = {
    caseId: "case-1",
    currentStageId: "gita",
    moves: [
      { toStageId: "gita", at: "2026-10-10T09:00:00.000Z", forced: true },
      { toStageId: "discovery", at: "2026-10-01T09:00:00.000Z", forced: false },
      { toStageId: "paused", at: "2026-10-05T09:00:00.000Z", forced: false },
      { toStageId: "gone", at: "2026-10-06T09:00:00.000Z", forced: false },
    ],
    stages: [
      { id: "discovery", name: "Executive Discovery", kind: "working" },
      { id: "paused", name: "Paused", kind: "cancelled" },
      { id: "gita", name: "GITA", kind: "working" },
    ],
    nda: { status: "accepted", acceptedAt: "2026-10-02T09:00:00.000Z", changedAt: "2026-10-02T09:00:00.000Z" },
    engagement: { status: "accepted", sentAt: "2026-10-03T09:00:00.000Z", acceptedAt: "2026-10-04T09:00:00.000Z" },
    publications: [
      { id: "p1", title: "North Star", status: "accepted", publishedAt: "2026-10-11T09:00:00.000Z", acceptedAt: "2026-10-12T09:00:00.000Z" },
      { id: "p2", title: "Draft report", status: "approved", publishedAt: null, acceptedAt: null },
    ],
  };

  it("lists stored stage moves in order, each with when it was left", () => {
    const timeline = buildEngagementTimeline(base);
    expect(timeline.stages.map((stage) => [stage.name, stage.enteredAt.slice(0, 10), stage.leftAt?.slice(0, 10) ?? null, stage.current]))
      .toEqual([
        ["Executive Discovery", "2026-10-01", "2026-10-05", false],
        ["Paused", "2026-10-05", "2026-10-10", false],
        ["GITA", "2026-10-10", null, true],
      ]);
    expect(timeline.milestones.map((milestone) => milestone.label)).toEqual([
      "NDA accepted",
      "Engagement pack sent",
      "Engagement pack accepted",
      "North Star published",
      "North Star accepted",
    ]);
  });

  it("shows the client only journey stages, without internal flags or ids", () => {
    const safe = clientSafeEngagementTimeline(buildEngagementTimeline(base));
    expect(safe.stages.map((stage) => stage.name)).toEqual(["Executive Discovery", "GITA"]);
    expect(safe.stages.every((stage) => !("forced" in stage))).toBe(true);
    expect(safe.milestones.every((milestone) => !("publicationId" in milestone))).toBe(true);
  });

  it("shows a suspended NDA by its change date and nothing for a pack not sent", () => {
    const timeline = buildEngagementTimeline({
      ...base,
      nda: { status: "suspended", acceptedAt: null, changedAt: "2026-10-02T10:00:00.000Z" },
      engagement: { status: "not_sent", sentAt: null, acceptedAt: null },
      publications: [],
    });
    expect(timeline.milestones.map((milestone) => milestone.kind)).toEqual(["nda_suspended"]);
  });
});
