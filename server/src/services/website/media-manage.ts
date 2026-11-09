import { and, eq, isNull, like, ne, or, type Column } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, documentRevisions, documents, websiteEntry, websitePage } from "@greatstone/db";
import type { WebsiteMediaUse } from "@greatstone/shared";
import type { EntryRow } from "./module.js";

// Media rename and delete (GRE-4785, GRE-4079 step 5d). Rename changes only the media entry's name: pages and
// releases point at the file by its asset id and hash, never by the name. Delete archives the entry, so it leaves the
// site at the next Publish and its history stays; the file stays in the company's files. It is refused while a
// page or entry still uses the file in its draft, its approved version or what is live.

/** Pages and entries (other than media entries) whose draft, approved or live content names the media's file. */
export async function websiteMediaUses(db: Db, entry: EntryRow, assetId: string): Promise<WebsiteMediaUse[]> {
  const [asset] = await db
    .select({ sha256: assets.sha256 })
    .from(assets)
    .where(and(eq(assets.companyId, entry.companyId), eq(assets.id, assetId)));
  // Block pages store `media:<asset id>`; HTML pages load `/media/<sha256>.<ext>`. Both are plain hex, so LIKE is exact.
  const needles = [assetId, asset?.sha256].filter((value): value is string => typeof value === "string" && /^[0-9a-f-]+$/i.test(value));
  const names = (column: Column) => or(...needles.map((needle) => like(column, `%${needle}%`)));

  // Another media entry for the same file keeps it in the release, so nothing that uses it breaks.
  const [twin] = await db
    .select({ id: websiteEntry.id })
    .from(websiteEntry)
    .innerJoin(documents, eq(documents.id, websiteEntry.documentId))
    .where(and(
      eq(websiteEntry.companyId, entry.companyId), eq(websiteEntry.siteId, entry.siteId), eq(websiteEntry.collection, "media"),
      ne(websiteEntry.id, entry.id), isNull(websiteEntry.archivedAt), like(documents.latestBody, `%${assetId}%`),
    ))
    .limit(1);
  if (twin) return [];

  const pageScope = and(eq(websitePage.companyId, entry.companyId), eq(websitePage.siteId, entry.siteId), isNull(websitePage.archivedAt));
  const entryScope = and(
    eq(websiteEntry.companyId, entry.companyId), eq(websiteEntry.siteId, entry.siteId), isNull(websiteEntry.archivedAt),
    ne(websiteEntry.collection, "media"),
  );
  const pagesByDraft = await db
    .select({ id: websitePage.id, title: websitePage.title })
    .from(websitePage)
    .innerJoin(documents, eq(documents.id, websitePage.documentId))
    .where(and(pageScope, names(documents.latestBody)));
  const pagesByRelease = await db
    .select({ id: websitePage.id, title: websitePage.title })
    .from(websitePage)
    .innerJoin(documentRevisions, and(
      eq(documentRevisions.companyId, entry.companyId),
      or(eq(documentRevisions.id, websitePage.approvedRevisionId), eq(documentRevisions.id, websitePage.publishedRevisionId)),
    ))
    .where(and(pageScope, names(documentRevisions.body)));
  const entriesByDraft = await db
    .select({ id: websiteEntry.id, collection: websiteEntry.collection, key: websiteEntry.entryKey })
    .from(websiteEntry)
    .innerJoin(documents, eq(documents.id, websiteEntry.documentId))
    .where(and(entryScope, names(documents.latestBody)));
  const entriesByRelease = await db
    .select({ id: websiteEntry.id, collection: websiteEntry.collection, key: websiteEntry.entryKey })
    .from(websiteEntry)
    .innerJoin(documentRevisions, and(
      eq(documentRevisions.companyId, entry.companyId),
      or(eq(documentRevisions.id, websiteEntry.approvedRevisionId), eq(documentRevisions.id, websiteEntry.publishedRevisionId)),
    ))
    .where(and(entryScope, names(documentRevisions.body)));

  const uses = new Map<string, WebsiteMediaUse>();
  for (const page of [...pagesByDraft, ...pagesByRelease]) uses.set(page.id, { kind: "page", id: page.id, title: page.title });
  for (const row of [...entriesByDraft, ...entriesByRelease]) uses.set(row.id, { kind: "entry", id: row.id, title: `${row.collection}/${row.key}` });
  return [...uses.values()].sort((a, b) => a.title.localeCompare(b.title));
}
