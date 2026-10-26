import { describe, expect, it } from "vitest";
import {
  deepDiveInterviewInviteeSchema,
  deepDiveInterviewSendKindFor,
  gsInterviewRoundItemSchema,
  gsInterviewRoundPayloadSchema,
  openDeepDiveInterviewRoundSchema,
  websiteUserIdSchema,
} from "./deep-dive-interview-invites.js";

const round = {
  schema: "gs-interview-round-v1",
  clientName: "Northwind Freight",
  sponsor: null,
  mode: "team",
  targetMinutes: 20,
  status: "open",
  seatTotal: 40,
  enrol: { enabled: true, expiresAt: null, allowedEmailDomains: ["northwind.example"], defaultUnitId: null, rotateToken: false },
  units: [{ id: "u1", parentId: null, name: "Finance", kind: "team" }],
  contextPack: { scope: "Finance month-end", units: { u1: "Questions:\n1. How does month-end work?" } },
} as const;

describe("gs-interview-v1 round (GRE-2653 retention fields)", () => {
  it("accepts a round without the optional retention fields", () => {
    expect(gsInterviewRoundPayloadSchema.safeParse(round).success).toBe(true);
  });

  it("accepts retentionDays from 0 to 3650 and readoutAt as ISO or null", () => {
    expect(gsInterviewRoundPayloadSchema.safeParse({ ...round, retentionDays: 0, readoutAt: null }).success).toBe(true);
    expect(gsInterviewRoundPayloadSchema.safeParse({ ...round, retentionDays: 3650, readoutAt: "2026-11-13T09:00:00Z" }).success).toBe(true);
    expect(gsInterviewRoundPayloadSchema.safeParse({ ...round, retentionDays: 3651 }).success).toBe(false);
    expect(gsInterviewRoundPayloadSchema.safeParse({ ...round, retentionDays: -1 }).success).toBe(false);
    expect(gsInterviewRoundPayloadSchema.safeParse({ ...round, readoutAt: "next week" }).success).toBe(false);
  });

  it("reads a round view with or without retentionDays, readoutAt, closedAt and deletionDate", () => {
    expect(gsInterviewRoundItemSchema.parse({ id: "r1", status: "open" })).toEqual({
      id: "r1", status: "open", joinUrl: null, retentionDays: null, readoutAt: null, closedAt: null, deletionDate: null,
    });
    expect(gsInterviewRoundItemSchema.parse({
      id: "r1", status: "closed", joinUrl: "https://example.test/#join/abc", retentionDays: 90,
      readoutAt: "2026-11-13T09:00:00Z", closedAt: "2026-11-13T17:00:00Z", deletionDate: "2027-02-11",
    })).toMatchObject({ retentionDays: 90, deletionDate: "2027-02-11" });
  });
});

describe("invites", () => {
  it("takes an email or an existing website user id, never both or neither", () => {
    expect(deepDiveInterviewInviteeSchema.safeParse({ name: "Yaw", email: "yaw@northwind.example" }).success).toBe(true);
    expect(deepDiveInterviewInviteeSchema.safeParse({ name: "Yaw", websiteUserId: "usr_123" }).success).toBe(true);
    expect(deepDiveInterviewInviteeSchema.safeParse({ name: "Yaw" }).success).toBe(false);
    expect(deepDiveInterviewInviteeSchema.safeParse({ name: "Yaw", email: "yaw@northwind.example", websiteUserId: "usr_123" }).success).toBe(false);
    expect(deepDiveInterviewInviteeSchema.safeParse({ email: "yaw@northwind.example" }).success).toBe(false);
  });

  it("never takes an email or a name as a website user id", () => {
    expect(websiteUserIdSchema.safeParse("usr_123-abc").success).toBe(true);
    expect(websiteUserIdSchema.safeParse("yaw@northwind.example").success).toBe(false);
    expect(websiteUserIdSchema.safeParse("Yaw Darko").success).toBe(false);
  });

  it("opens with at least one email domain, lower-cased", () => {
    expect(openDeepDiveInterviewRoundSchema.parse({ allowedEmailDomains: ["Northwind.Example"], seatTotal: 5 }).allowedEmailDomains).toEqual(["northwind.example"]);
    expect(openDeepDiveInterviewRoundSchema.safeParse({ allowedEmailDomains: [], seatTotal: 5 }).success).toBe(false);
    expect(openDeepDiveInterviewRoundSchema.safeParse({ allowedEmailDomains: ["@northwind"], seatTotal: 5 }).success).toBe(false);
  });

  it("resends to people who have not started and reminds people who have not finished", () => {
    expect(deepDiveInterviewSendKindFor("invited")).toBe("resend");
    expect(deepDiveInterviewSendKindFor("started")).toBe("remind");
    expect(deepDiveInterviewSendKindFor("completed")).toBeNull();
    expect(deepDiveInterviewSendKindFor("declined")).toBeNull();
  });
});
