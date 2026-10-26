import { describe, expect, it } from "vitest";
import { dryRunClientPeople, type ClientPeopleSnapshot } from "./client-people-dry-run.js";

const companyId = "company-a";
const organisationId = "crm-org-a";
const websiteOrganisationId = "site-org-a";
const snapshot = (): ClientPeopleSnapshot => ({
  companyId,
  organisations: [{ id: organisationId, companyId, websiteOrganisationId }],
  people: [
    { kind: "gsam_contact", id: "1", companyId, organisationId, email: "ONE@example.com", websiteUserId: null },
    { kind: "organisation_member", id: "2", companyId, organisationId, email: "two@example.com", websiteUserId: null },
    { kind: "pipedrive_person", id: "3", companyId, organisationId, email: "three@example.com", websiteUserId: null },
    { kind: "old_supabase_user", id: "4", companyId, organisationId: null, email: "four@example.com", websiteUserId: null },
  ],
  websiteUsers: [
    { id: "site-user-1", email: "one@example.com", organisationIds: [websiteOrganisationId] },
    { id: "site-user-2", email: "two@example.com", organisationIds: ["other-org"] },
  ],
});

describe("client people dry run", () => {
  it("counts every source and sends email-only conflicts to review", () => {
    const report = dryRunClientPeople(snapshot());
    expect(report.counts).toEqual({ matched: 1, wouldCreate: 1, ambiguous: 1, leftBehind: 1 });
    expect(report.total).toBe(4);
    expect(report.distinctWebsiteUsersToCreate).toBe(1);
    expect(report.reviewList).toMatchObject([{ kind: "organisation_member", id: "2", sourceEmail: "two@example.com",
      candidateUsers: [{ id: "site-user-2", organisationIds: ["other-org"] }] }]);
    expect(report.rows[0]).toMatchObject({ websiteUserId: "site-user-1", reason: "email_and_linked_organisation" });
  });

  it("requires an explicit person and a valid website membership for a review decision", () => {
    const input = snapshot();
    input.websiteUsers.push({ id: "site-user-3", email: "different@example.com", organisationIds: [websiteOrganisationId] });
    input.decisions = [{ kind: "organisation_member", id: "2", websiteUserId: "site-user-3",
      websiteOrganisationId, confirmedBy: "reviewer-1", confirmedAt: "2026-10-26T10:00:00Z" }];
    expect(dryRunClientPeople(input).rows[1]).toMatchObject({ status: "matched", reason: "person_confirmed",
      websiteUserId: "site-user-3", confirmedBy: "reviewer-1" });
    input.decisions[0]!.websiteUserId = "site-user-2";
    expect(() => dryRunClientPeople(input)).toThrow("does not select a website member");
    input.decisions[0]!.id = "1";
    input.decisions[0]!.kind = "gsam_contact";
    input.decisions[0]!.websiteUserId = "site-user-3";
    expect(() => dryRunClientPeople(input)).toThrow("not on the ambiguous review list");
  });

  it("refuses cross-company rows, duplicate ids and conflicting stored ids", () => {
    const input = snapshot();
    input.people[0]!.companyId = "company-b";
    expect(() => dryRunClientPeople(input)).toThrow("another company");
    input.people[0]!.companyId = companyId;
    input.people.push({ ...input.people[0]! });
    expect(() => dryRunClientPeople(input)).toThrow("Duplicate person");
    input.people.pop();
    input.people[0]!.websiteUserId = "site-user-2";
    expect(dryRunClientPeople(input).rows[0]).toMatchObject({ status: "ambiguous", reason: "stored_user_conflict" });
  });

  it("deduplicates proposed website creations across source records", () => {
    const input = snapshot();
    input.people.push({ kind: "old_supabase_user", id: "5", companyId, organisationId,
      email: "THREE@example.com", websiteUserId: null });
    const report = dryRunClientPeople(input);
    expect(report.counts.wouldCreate).toBe(2);
    expect(report.distinctWebsiteUsersToCreate).toBe(1);
  });
});
