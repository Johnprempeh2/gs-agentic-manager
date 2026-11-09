import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { documents, websiteEntry, websitePage } from "@greatstone/db";
import {
  WEBSITE_REDIRECT_STATUSES,
  websiteRedirectInputSchema,
  type WebsiteEntryStatus,
  type WebsiteRedirect,
  type WebsiteRedirectInput,
  type WebsiteRedirectStatus,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../../errors.js";
import type { EntryRow, SiteRow, WebsiteActor, websiteModuleService } from "./module.js";

// Redirects (GRE-4785, GRE-4079 step 5d). A redirect is a `redirect` collection entry, so it is drafted, sent for
// review, approved by a person and published with the site release like every other entry. These checks keep the
// list one the site can serve: one redirect per old path, never from a page that is still there, and no loop.

type ModuleService = ReturnType<typeof websiteModuleService>;
type Parsed = { from: string; to: string; status: WebsiteRedirectStatus };

const COLLECTION = "redirect";
/** A chain longer than this is refused as if it were a loop: no visitor should be sent on that many times. */
const MAX_CHAIN = 20;

function parseFields(body: string | null): Parsed | null {
  try {
    const fields = JSON.parse(body ?? "null") as Record<string, unknown> | null;
    if (!fields || typeof fields.from !== "string" || typeof fields.to !== "string") return null;
    const status = (WEBSITE_REDIRECT_STATUSES as readonly unknown[]).includes(fields.status) ? fields.status as WebsiteRedirectStatus : 301;
    return { from: fields.from, to: fields.to, status };
  } catch {
    return null;
  }
}

export function websiteRedirectService(db: Db, module: ModuleService) {
  async function rows(site: Pick<SiteRow, "companyId" | "id">) {
    const found = await db
      .select({ entry: websiteEntry, body: documents.latestBody, latestRevisionId: documents.latestRevisionId })
      .from(websiteEntry)
      .innerJoin(documents, and(eq(documents.id, websiteEntry.documentId), eq(documents.companyId, site.companyId)))
      .where(and(eq(websiteEntry.companyId, site.companyId), eq(websiteEntry.siteId, site.id), eq(websiteEntry.collection, COLLECTION), isNull(websiteEntry.archivedAt)))
      .orderBy(asc(websiteEntry.entryKey));
    return found.flatMap((row) => {
      const fields = parseFields(row.body);
      if (!fields) return [];
      const redirect: WebsiteRedirect = {
        entryId: row.entry.id,
        key: row.entry.entryKey,
        ...fields,
        state: row.entry.status as WebsiteEntryStatus,
        latestRevisionId: row.latestRevisionId,
        updatedAt: row.entry.updatedAt.toISOString(),
      };
      return [redirect];
    });
  }

  async function list(site: SiteRow) {
    return (await rows(site)).sort((a, b) => a.from.localeCompare(b.from));
  }

  /** Refuses a redirect the site could not serve as meant. `others` are the site's redirects except the one being changed. */
  async function assertServable(site: SiteRow, next: Parsed, others: WebsiteRedirect[]) {
    if (next.from === next.to) {
      throw unprocessable("The old path and the new address are the same.", { code: "website_redirect_to_itself" });
    }
    const taken = others.find((other) => other.from === next.from);
    if (taken) {
      throw conflict(`There is already a redirect from ${next.from} (to ${taken.to}). Change that one instead.`, {
        code: "website_redirect_from_taken", entryId: taken.entryId,
      });
    }
    const [page] = await db
      .select({ id: websitePage.id, title: websitePage.title })
      .from(websitePage)
      .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id), eq(websitePage.slug, next.from), isNull(websitePage.archivedAt)));
    if (page) {
      throw unprocessable(`The page "${page.title}" is at ${next.from}. Move or archive the page first, or pick another old path.`, {
        code: "website_redirect_from_is_page", pageId: page.id,
      });
    }
    const to = new Map(others.map((other) => [other.from, other.to]));
    let at = next.to;
    for (let step = 0; step < MAX_CHAIN && to.has(at); step++) {
      at = to.get(at)!;
      if (at === next.from) {
        throw unprocessable(`This redirect makes a loop: ${next.to} already leads back to ${next.from}.`, { code: "website_redirect_loop" });
      }
    }
    if (to.has(at)) throw unprocessable("This redirect starts a chain of more than 20 redirects.", { code: "website_redirect_loop" });
  }

  /** A new draft redirect. The same redirect again (same from, to and status) answers the one already there. */
  async function create(site: SiteRow, input: WebsiteRedirectInput, actor: WebsiteActor) {
    const next = websiteRedirectInputSchema.parse(input);
    const existing = await rows(site);
    const same = existing.find((other) => other.from === next.from && other.to === next.to && other.status === next.status);
    if (same) return { redirect: same, created: false };
    await assertServable(site, next, existing);
    const key = `redirect-${randomUUID().slice(0, 8)}`;
    const entry = await module.createEntry(site.companyId, site.id, { collection: COLLECTION, entryKey: key, content: { id: key, ...next } }, actor);
    const redirect = (await rows(site)).find((row) => row.entryId === entry.id)!;
    return { redirect, created: true };
  }

  /** A new revision of the redirect, back to draft so a person approves it again. */
  async function update(site: SiteRow, entry: EntryRow, input: WebsiteRedirectInput & { baseRevisionId: string }, actor: WebsiteActor) {
    const { baseRevisionId, ...fields } = input;
    const next = websiteRedirectInputSchema.parse(fields);
    const existing = await rows(site);
    await assertServable(site, next, existing.filter((row) => row.entryId !== entry.id));
    const result = await module.saveEntryRevision(entry, {
      content: { id: entry.entryKey, ...next },
      baseRevisionId,
      changeSummary: `Redirect ${next.from} to ${next.to} (${next.status})`,
      actor,
    });
    if (result.state === "conflict") {
      throw conflict("Someone changed this redirect after you opened it. Read it again, then make your change.", { code: "website_redirect_stale" });
    }
    if (result.state !== "saved") throw unprocessable(result.message, { code: "website_redirect_invalid" });
    return (await rows(site)).find((row) => row.entryId === entry.id)!;
  }

  return { list, create, update };
}
