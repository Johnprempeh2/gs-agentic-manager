import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { crmSyncBindings, crmSyncRecordLinks, toolConnections } from "@greatstone/db";
import { logActivity } from "../activity-log.js";
import { createPipedriveClient, resolvePipedriveBaseUrl, type PipedriveClient } from "../crm-sync-pipedrive.js";
import { resolveCrmConnectionCredential } from "../crm-sync-runner.js";
import type { WebsiteEnquiry } from "./enquiries.js";

const MAX_REMOTE_PAGES = 200;

/** Stable across retries and unique across websites that reuse a local enquiry id. */
export function pipedriveWebsiteOriginId(siteId: string, enquiryId: string) {
  const digest = createHash("sha256").update(siteId).update("\0").update(enquiryId).digest("hex");
  return `gsam:website:${digest}`;
}

function personEmails(person: Record<string, unknown>): string[] {
  const raw = person.email ?? person.emails;
  if (typeof raw === "string") return [raw.toLowerCase()];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => typeof entry === "string"
    ? [entry.toLowerCase()]
    : entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string"
      ? [(entry as { value: string }).value.toLowerCase()]
      : []);
}

async function existingLead(client: PipedriveClient, originId: string): Promise<string | null> {
  for (const archived of [false, true]) {
    let start: number | undefined;
    for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
      const batch: { items: Record<string, unknown>[]; nextStart: number | null } = archived
        ? await client.listArchivedLeadsPage({ start })
        : await client.listLeadsPage({ start });
      const found = batch.items.find((lead) => lead.origin_id === originId);
      if (found && typeof found.id === "string") return found.id;
      if (batch.nextStart === null) break;
      if (page === MAX_REMOTE_PAGES - 1) throw new Error("Pipedrive lead search exceeded its page limit");
      start = batch.nextStart;
    }
  }
  return null;
}

async function personIdFor(client: PipedriveClient, enquiry: WebsiteEnquiry): Promise<number> {
  let start: number | undefined;
  for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
    const batch = await client.listPersonsPage({ start });
    const found = batch.items.find((person) => personEmails(person).includes(enquiry.email.trim().toLowerCase()));
    if (found) return found.id;
    if (batch.nextStart === null) break;
    if (page === MAX_REMOTE_PAGES - 1) throw new Error("Pipedrive person search exceeded its page limit");
    start = batch.nextStart;
  }
  const created = await client.createPerson({ name: enquiry.name.trim(), email: enquiry.email.trim() });
  if (!Number.isInteger(created.id)) throw new Error("Pipedrive did not return a person id");
  return created.id;
}

export function websiteEnquiryPipedriveCopy(
  db: Db,
  deps: {
    clientForConnection?: (connection: typeof toolConnections.$inferSelect) => Promise<PipedriveClient>;
  } = {},
) {
  return async (input: { companyId: string; siteId: string; caseId: string; enquiry: WebsiteEnquiry }) => {
    const [binding] = await db.select({ connection: toolConnections }).from(crmSyncBindings)
      .innerJoin(toolConnections, and(
        eq(toolConnections.id, crmSyncBindings.connectionId),
        eq(toolConnections.companyId, crmSyncBindings.companyId),
      ))
      .where(and(
        eq(crmSyncBindings.companyId, input.companyId),
        eq(crmSyncBindings.providerKey, "pipedrive"),
        eq(crmSyncBindings.status, "active"),
        isNull(crmSyncBindings.deletedAt),
        eq(toolConnections.enabled, true),
        eq(toolConnections.status, "active"),
      ))
      .orderBy(asc(crmSyncBindings.createdAt))
      .limit(1);
    if (!binding) throw new Error("No active Pipedrive sync connection is available for website enquiries");
    const connection = binding.connection;
    const [alreadyLinked] = await db.select({ externalId: crmSyncRecordLinks.externalId })
      .from(crmSyncRecordLinks).where(and(
        eq(crmSyncRecordLinks.companyId, input.companyId),
        eq(crmSyncRecordLinks.entityKind, "case"),
        eq(crmSyncRecordLinks.entityId, input.caseId),
        eq(crmSyncRecordLinks.connectionId, connection.id),
      )).limit(1);
    if (alreadyLinked) return { externalId: alreadyLinked.externalId, created: false };
    const client = deps.clientForConnection
      ? await deps.clientForConnection(connection)
      : createPipedriveClient({
        token: await resolveCrmConnectionCredential(db, connection),
        authKind: connection.authKind,
        baseUrl: resolvePipedriveBaseUrl(connection.config),
      });
    const originId = pipedriveWebsiteOriginId(input.siteId, input.enquiry.id);

    // The database lock serialises parallel pollers. If a process dies after
    // POST and before commit, the next pass finds the lead by origin_id.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.caseId}), hashtext(${connection.id}))`);
      const [linked] = await tx.select({ externalId: crmSyncRecordLinks.externalId }).from(crmSyncRecordLinks).where(and(
        eq(crmSyncRecordLinks.companyId, input.companyId),
        eq(crmSyncRecordLinks.entityKind, "case"),
        eq(crmSyncRecordLinks.entityId, input.caseId),
        eq(crmSyncRecordLinks.connectionId, connection.id),
      )).limit(1);
      if (linked) return { externalId: linked.externalId, created: false, newLink: false };

      let externalId = await existingLead(client, originId);
      const created = !externalId;
      if (!externalId) {
        const personId = await personIdFor(client, input.enquiry);
        const lead = await client.createLead({
          title: `${input.enquiry.name.trim()} — website enquiry`,
          personId,
          originId,
        });
        if (!lead.id) throw new Error("Pipedrive did not return a lead id");
        externalId = lead.id;
      }
      await tx.insert(crmSyncRecordLinks).values({
        companyId: input.companyId,
        entityKind: "case",
        entityId: input.caseId,
        connectionId: connection.id,
        providerKey: "pipedrive",
        externalId,
        lastSyncedAt: new Date(),
      }).onConflictDoNothing();
      return { externalId, created, newLink: true };
    });
    if (result.newLink) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "website-enquiry-pipedrive-copy",
        action: "website.enquiry.pipedrive_copied",
        entityType: "pipeline_case",
        entityId: input.caseId,
        details: { externalId: result.externalId, siteId: input.siteId },
      });
    }
    return { externalId: result.externalId, created: result.created };
  };
}
