import { z } from "zod";

const id = z.string().trim().min(1);
const personKind = z.enum(["gsam_contact", "organisation_member", "pipedrive_person", "old_supabase_user"]);

/** Exported copies only. This module has no database or bridge write path. */
export const clientPeopleSnapshotSchema = z.object({
  companyId: id,
  organisations: z.array(z.object({
    id,
    companyId: id,
    websiteOrganisationId: id.nullable(),
  }).strict()),
  people: z.array(z.object({
    kind: personKind,
    id,
    companyId: id,
    organisationId: id.nullable(),
    email: z.string().email().nullable(),
    websiteUserId: id.nullable(),
  }).strict()),
  websiteUsers: z.array(z.object({
    id,
    email: z.string().email(),
    organisationIds: z.array(id),
  }).strict()),
  decisions: z.array(z.object({
    kind: personKind,
    id,
    websiteUserId: id,
    websiteOrganisationId: id,
    confirmedBy: id,
    confirmedAt: z.string().datetime({ offset: true }),
  }).strict()).default([]),
}).strict();

export type ClientPeopleSnapshot = z.input<typeof clientPeopleSnapshotSchema>;
type Person = z.output<typeof clientPeopleSnapshotSchema>["people"][number];
type WebsiteUser = z.output<typeof clientPeopleSnapshotSchema>["websiteUsers"][number];

const keyOf = (person: Pick<Person, "kind" | "id">) => `${person.kind}:${person.id}`;
const emailOf = (email: string | null) => email?.trim().toLowerCase() ?? null;

export function dryRunClientPeople(input: ClientPeopleSnapshot) {
  const snapshot = clientPeopleSnapshotSchema.parse(input);
  const organisations = new Map<string, string | null>();
  const linkedOrganisationIds = new Set<string>();
  const users = new Map<string, WebsiteUser>();
  const usersByEmail = new Map<string, WebsiteUser[]>();
  const decisions = new Map<string, (typeof snapshot.decisions)[number]>();
  const personKeys = new Set<string>();

  for (const org of snapshot.organisations) {
    if (org.companyId !== snapshot.companyId) throw new Error(`Organisation ${org.id} belongs to another company`);
    if (organisations.has(org.id)) throw new Error(`Duplicate organisation ${org.id}`);
    if (org.websiteOrganisationId && linkedOrganisationIds.has(org.websiteOrganisationId)) {
      throw new Error(`Duplicate website organisation link ${org.websiteOrganisationId}`);
    }
    organisations.set(org.id, org.websiteOrganisationId);
    if (org.websiteOrganisationId) linkedOrganisationIds.add(org.websiteOrganisationId);
  }
  for (const user of snapshot.websiteUsers) {
    if (users.has(user.id)) throw new Error(`Duplicate website user ${user.id}`);
    users.set(user.id, user);
    const email = emailOf(user.email)!;
    usersByEmail.set(email, [...(usersByEmail.get(email) ?? []), user]);
  }
  for (const person of snapshot.people) {
    if (person.companyId !== snapshot.companyId) throw new Error(`Person ${keyOf(person)} belongs to another company`);
    if (personKeys.has(keyOf(person))) throw new Error(`Duplicate person ${keyOf(person)}`);
    personKeys.add(keyOf(person));
  }
  for (const decision of snapshot.decisions) {
    const key = keyOf(decision);
    if (!personKeys.has(key)) throw new Error(`Decision names an unknown person ${key}`);
    if (decisions.has(key)) throw new Error(`Duplicate decision ${key}`);
    decisions.set(key, decision);
  }

  const rows = snapshot.people.map((person) => {
    const key = keyOf(person);
    const organisationId = person.organisationId ? organisations.get(person.organisationId) : undefined;
    const base = { kind: person.kind, id: person.id, sourceEmail: person.email,
      websiteOrganisationId: organisationId ?? null };
    if (!organisationId) {
      if (decisions.has(key)) throw new Error(`Decision ${key} has no linked website organisation`);
      return { ...base, status: "left_behind" as const,
        reason: person.organisationId && organisations.has(person.organisationId) ? "organisation_not_linked" : "organisation_unknown",
        websiteUserId: null, candidateUserIds: [] as string[] };
    }

    const email = emailOf(person.email);
    const emailUsers = email ? (usersByEmail.get(email) ?? []) : [];
    const linked = person.websiteUserId ? users.get(person.websiteUserId) : undefined;
    const candidates = [...new Set([...emailUsers.map((user) => user.id), ...(person.websiteUserId ? [person.websiteUserId] : [])])].sort();
    const candidateUsers = candidates.flatMap((userId) => {
      const user = users.get(userId);
      return user ? [{ id: user.id, email: user.email, organisationIds: user.organisationIds }] : [];
    });
    const decision = decisions.get(key);
    if (decision) {
      const storedConflict = !!person.websiteUserId && !(linked?.organisationIds.includes(organisationId) &&
        (emailUsers.length === 0 || (emailUsers.length === 1 && emailUsers[0]?.id === linked.id)));
      const emailConflict = !person.websiteUserId && emailUsers.length > 0 &&
        !(emailUsers.length === 1 && emailUsers[0]!.organisationIds.includes(organisationId));
      if (!storedConflict && !emailConflict) throw new Error(`Decision ${key} is not on the ambiguous review list`);
      const selected = users.get(decision.websiteUserId);
      if (decision.websiteOrganisationId !== organisationId || !selected?.organisationIds.includes(organisationId)) {
        throw new Error(`Decision ${key} does not select a website member of the linked organisation`);
      }
      if (person.websiteUserId && person.websiteUserId !== selected.id) {
        throw new Error(`Decision ${key} conflicts with the stored website user id`);
      }
      return { ...base, status: "matched" as const, reason: "person_confirmed", websiteUserId: selected.id,
        candidateUserIds: candidates, candidateUsers, confirmedBy: decision.confirmedBy, confirmedAt: decision.confirmedAt };
    }
    if (person.websiteUserId) {
      if (linked?.organisationIds.includes(organisationId) && (emailUsers.length === 0 ||
        (emailUsers.length === 1 && emailUsers[0]?.id === linked.id))) {
        return { ...base, status: "matched" as const, reason: "stored_user_and_organisation", websiteUserId: linked.id,
          candidateUserIds: candidates, candidateUsers };
      }
      return { ...base, status: "ambiguous" as const, reason: "stored_user_conflict", websiteUserId: null,
        candidateUserIds: candidates, candidateUsers };
    }
    if (!email) return { ...base, status: "left_behind" as const, reason: "email_missing", websiteUserId: null,
      candidateUserIds: candidates };
    if (emailUsers.length === 1 && emailUsers[0]!.organisationIds.includes(organisationId)) {
      return { ...base, status: "matched" as const, reason: "email_and_linked_organisation", websiteUserId: emailUsers[0]!.id,
        candidateUserIds: candidates, candidateUsers };
    }
    if (emailUsers.length > 0) return { ...base, status: "ambiguous" as const,
      reason: emailUsers.length > 1 ? "multiple_website_users" : "organisation_membership_missing",
      websiteUserId: null, candidateUserIds: candidates, candidateUsers };
    return { ...base, status: "would_create" as const, reason: "no_website_user", websiteUserId: null,
      candidateUserIds: candidates, creationKey: `${organisationId}:${email}` };
  });

  const counts = {
    matched: rows.filter((row) => row.status === "matched").length,
    wouldCreate: rows.filter((row) => row.status === "would_create").length,
    ambiguous: rows.filter((row) => row.status === "ambiguous").length,
    leftBehind: rows.filter((row) => row.status === "left_behind").length,
  };
  return {
    companyId: snapshot.companyId,
    total: rows.length,
    counts,
    distinctWebsiteUsersToCreate: new Set(rows.flatMap((row) => "creationKey" in row ? [row.creationKey] : [])).size,
    rows,
    reviewList: rows.filter((row) => row.status === "ambiguous"),
  };
}
