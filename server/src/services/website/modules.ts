import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companyMemberships,
  issueApprovals,
  issueThreadInteractions,
  issues,
  projects,
  websiteEntry,
  websiteModule,
  websitePage,
  websitePulls,
  websiteRelease,
} from "@greatstone/db";
import {
  GREATSTONE_STARTING_MODULES,
  websiteModuleForPath,
  type CreateWebsiteModule,
  type UpdateWebsiteModule,
  type WebsiteGa4Report,
  type WebsiteHomeActivity,
  type WebsiteModule,
  type WebsiteModuleCard,
  type WebsiteModuleDetail,
  type WebsiteModuleHealth,
  type WebsiteModuleIcon,
  type WebsiteModuleRelease,
  type WebsitePageStatus,
  type WebsiteReleaseStatus,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../../errors.js";
import type { SiteRow } from "./module.js";

// Website modules (GRE-2325). The registry is company- and site-scoped; every
// query below filters by company_id first. The cards are read-only joins over
// pages, releases, the linked project's tasks and the latest Google pull.

export type ModuleRow = typeof websiteModule.$inferSelect;

const RELEASE_LOOKBACK = 40;
const RECENT_CHANGES = 10;
const CLOSED_TASK_STATUSES = ["done", "cancelled"];
const TROUBLED_RELEASES: WebsiteReleaseStatus[] = ["failed", "checks_failed", "pending"];

export function toWebsiteModule(row: ModuleRow): WebsiteModule {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    key: row.key,
    name: row.name,
    purpose: row.purpose,
    icon: row.icon as WebsiteModuleIcon,
    ownerUserId: row.ownerUserId,
    leadAgentId: row.leadAgentId,
    projectId: row.projectId,
    routePrefixes: row.routePrefixes,
    collections: row.collections,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type ReleaseManifest = { pages?: Array<{ pageId: string; revisionId: string }>; entries?: Array<{ entryId: string; revisionId: string }> };
type ReleaseLite = { id: string; number: number; status: string; manifest: ReleaseManifest; liveAt: Date | null; createdAt: Date };

/**
 * The newest release that changed one of these pages or entries: a page or
 * entry whose released revision differs from the release before it, or that
 * appeared or left. Releases without a built manifest are skipped.
 */
export function lastReleaseTouching(releasesNewestFirst: ReleaseLite[], pageIds: Set<string>, entryIds: Set<string>): ReleaseLite | null {
  const built = releasesNewestFirst.filter((release) => Array.isArray(release.manifest.pages));
  const revisions = (release: ReleaseLite) => {
    const map = new Map<string, string>();
    for (const page of release.manifest.pages ?? []) if (pageIds.has(page.pageId)) map.set(`p:${page.pageId}`, page.revisionId);
    for (const entry of release.manifest.entries ?? []) if (entryIds.has(entry.entryId)) map.set(`e:${entry.entryId}`, entry.revisionId);
    return map;
  };
  for (let index = 0; index < built.length; index += 1) {
    const current = revisions(built[index]!);
    const previous = index + 1 < built.length ? revisions(built[index + 1]!) : new Map<string, string>();
    if (current.size !== previous.size) return built[index]!;
    for (const [key, revisionId] of current) if (previous.get(key) !== revisionId) return built[index]!;
  }
  return null;
}

export function moduleHealth(release: WebsiteModuleRelease | null, views: number | null): WebsiteModuleHealth {
  if (release && TROUBLED_RELEASES.includes(release.status)) {
    const what = release.status === "pending" ? "is pending" : "failed";
    return { state: "attention", reason: `Release ${release.number} changed these pages and ${what}.` };
  }
  if (views !== null && views > 0) {
    return { state: "ok", reason: `${views} page views in the last Google pull, and no failed release.` };
  }
  if (release) return { state: "ok", reason: `Release ${release.number} changed these pages and went through.` };
  return { state: "unknown", reason: "No traffic or release data for these pages yet." };
}

export function websiteModulesService(db: Db) {
  async function list(companyId: string, siteId: string): Promise<ModuleRow[]> {
    return db
      .select()
      .from(websiteModule)
      .where(and(eq(websiteModule.companyId, companyId), eq(websiteModule.siteId, siteId), isNull(websiteModule.archivedAt)))
      .orderBy(asc(websiteModule.sortOrder), asc(websiteModule.createdAt));
  }

  async function getRow(companyId: string, siteId: string, moduleId: string): Promise<ModuleRow | null> {
    const [row] = await db
      .select()
      .from(websiteModule)
      .where(and(eq(websiteModule.companyId, companyId), eq(websiteModule.siteId, siteId), eq(websiteModule.id, moduleId), isNull(websiteModule.archivedAt)));
    return row ?? null;
  }

  /** Owner, lead agent and project must belong to the same company. */
  async function assertLinks(companyId: string, input: { ownerUserId?: string | null; leadAgentId?: string | null; projectId?: string | null }) {
    if (input.ownerUserId) {
      const [member] = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.ownerUserId),
          eq(companyMemberships.status, "active"),
        ));
      if (!member) throw unprocessable("The owner must be a person in this company", { code: "website_module_owner_not_member" });
    }
    if (input.leadAgentId) {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, input.leadAgentId)));
      if (!agent) throw unprocessable("The lead agent must be an agent in this company", { code: "website_module_agent_not_found" });
    }
    if (input.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, input.projectId)));
      if (!project) throw unprocessable("The project must be in this company", { code: "website_module_project_not_found" });
    }
  }

  async function nextSortOrder(site: SiteRow) {
    const rows = await list(site.companyId, site.id);
    return rows.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
  }

  async function create(site: SiteRow, input: CreateWebsiteModule): Promise<ModuleRow> {
    await assertLinks(site.companyId, input);
    const existing = (await list(site.companyId, site.id)).find((row) => row.key === input.key);
    if (existing) throw conflict("This site already has a module with that key", { code: "website_module_key_taken" });
    const [row] = await db
      .insert(websiteModule)
      .values({
        companyId: site.companyId,
        siteId: site.id,
        key: input.key,
        name: input.name,
        purpose: input.purpose ?? "",
        icon: input.icon ?? "blocks",
        ownerUserId: input.ownerUserId ?? null,
        leadAgentId: input.leadAgentId ?? null,
        projectId: input.projectId ?? null,
        routePrefixes: input.routePrefixes ?? [],
        collections: input.collections ?? [],
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? (await nextSortOrder(site)),
      })
      .returning();
    return row!;
  }

  async function update(row: ModuleRow, input: UpdateWebsiteModule): Promise<ModuleRow> {
    await assertLinks(row.companyId, input);
    const [updated] = await db
      .update(websiteModule)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(websiteModule.companyId, row.companyId), eq(websiteModule.id, row.id)))
      .returning();
    return updated!;
  }

  /** Removes the module from the registry only; its pages, entries and tasks stay. */
  async function archive(row: ModuleRow): Promise<void> {
    await db
      .update(websiteModule)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(websiteModule.companyId, row.companyId), eq(websiteModule.id, row.id)));
  }

  /** Adds the starting modules the site does not have yet, by key. Running it twice adds nothing. */
  async function addStartingSet(site: SiteRow): Promise<{ added: ModuleRow[]; modules: ModuleRow[] }> {
    const have = new Set((await list(site.companyId, site.id)).map((row) => row.key));
    const missing = GREATSTONE_STARTING_MODULES.map((module, index) => ({ module, index })).filter(({ module }) => !have.has(module.key));
    const added = missing.length
      ? await db
        .insert(websiteModule)
        .values(missing.map(({ module, index }) => ({
          companyId: site.companyId,
          siteId: site.id,
          key: module.key,
          name: module.name,
          purpose: module.purpose,
          icon: module.icon,
          routePrefixes: module.routePrefixes,
          collections: module.collections,
          sortOrder: index,
        })))
        .returning()
      : [];
    return { added, modules: await list(site.companyId, site.id) };
  }

  /** Everything the cards share, read once per request. */
  async function context(site: SiteRow, rows: ModuleRow[]) {
    const { companyId } = site;
    const pages = await db
      .select({ id: websitePage.id, slug: websitePage.slug, title: websitePage.title, status: websitePage.status })
      .from(websitePage)
      .where(and(eq(websitePage.companyId, companyId), eq(websitePage.siteId, site.id), isNull(websitePage.archivedAt)))
      .orderBy(asc(websitePage.slug));
    const collections = [...new Set(rows.flatMap((row) => row.collections))];
    const entries = collections.length
      ? await db
        .select({ id: websiteEntry.id, collection: websiteEntry.collection })
        .from(websiteEntry)
        .where(and(eq(websiteEntry.companyId, companyId), eq(websiteEntry.siteId, site.id), inArray(websiteEntry.collection, collections)))
      : [];
    const releases = (await db
      .select({ id: websiteRelease.id, number: websiteRelease.number, status: websiteRelease.status, manifest: websiteRelease.manifest, liveAt: websiteRelease.liveAt, createdAt: websiteRelease.createdAt })
      .from(websiteRelease)
      .where(and(eq(websiteRelease.companyId, companyId), eq(websiteRelease.siteId, site.id)))
      .orderBy(desc(websiteRelease.number))
      .limit(RELEASE_LOOKBACK)) as ReleaseLite[];

    let topPages: WebsiteGa4Report["topPages"] | null = null;
    if (site.propertyId) {
      const [pull] = await db
        .select({ ga4: websitePulls.ga4Report })
        .from(websitePulls)
        .where(and(eq(websitePulls.companyId, companyId), eq(websitePulls.propertyId, site.propertyId), isNotNull(websitePulls.ga4Report)))
        .orderBy(desc(websitePulls.startedAt))
        .limit(1);
      topPages = (pull?.ga4 as WebsiteGa4Report | null | undefined)?.topPages ?? null;
    }

    const userIds = rows.map((row) => row.ownerUserId).filter((id): id is string => !!id);
    const people = new Map(
      (userIds.length ? await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)) : [])
        .map((row) => [row.id, row.name]),
    );
    const agentIds = rows.map((row) => row.leadAgentId).filter((id): id is string => !!id);
    const agentNames = new Map(
      (agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [])
        .map((row) => [row.id, row.name]),
    );
    const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => !!id))];
    const tasks = new Map<string, { open: number; needsPerson: number }>();
    for (const projectId of projectIds) tasks.set(projectId, await taskCounts(companyId, projectId));

    return { pages, entries, releases, topPages, people, agentNames, tasks };
  }

  async function taskCounts(companyId: string, projectId: string) {
    const open = and(
      eq(issues.companyId, companyId),
      eq(issues.projectId, projectId),
      isNull(issues.hiddenAt),
      notInArray(issues.status, CLOSED_TASK_STATUSES),
    );
    const [all] = await db.select({ n: count() }).from(issues).where(open);
    const waitingCard = sql`exists (select 1 from ${issueThreadInteractions} where ${issueThreadInteractions.issueId} = ${issues.id} and ${issueThreadInteractions.status} = 'pending')`;
    const waitingApproval = sql`exists (select 1 from ${issueApprovals} inner join ${approvals} on ${approvals.id} = ${issueApprovals.approvalId} where ${issueApprovals.issueId} = ${issues.id} and ${approvals.status} = 'pending')`;
    const [person] = await db
      .select({ n: count() })
      .from(issues)
      .where(and(open, or(isNotNull(issues.assigneeUserId), waitingCard, waitingApproval)));
    return { open: Number(all?.n ?? 0), needsPerson: Number(person?.n ?? 0) };
  }

  function cardFor(row: ModuleRow, rows: ModuleRow[], ctx: Awaited<ReturnType<typeof context>>) {
    const owned = ctx.pages.filter((page) => websiteModuleForPath(page.slug, rows) === row);
    const pageIds = new Set(owned.map((page) => page.id));
    const entryIds = new Set(ctx.entries.filter((entry) => row.collections.includes(entry.collection)).map((entry) => entry.id));
    const touched = lastReleaseTouching(ctx.releases, pageIds, entryIds);
    const lastRelease: WebsiteModuleRelease | null = touched
      ? { id: touched.id, number: touched.number, status: touched.status as WebsiteReleaseStatus, at: (touched.liveAt ?? touched.createdAt).toISOString() }
      : null;
    // Top pages are recorded by path; a pattern page (`/portal/:client`) never matches a real path, which is right: those are private.
    const views = ctx.topPages
      ? ctx.topPages.filter((page) => websiteModuleForPath(page.path, rows) === row).reduce((sum, page) => sum + page.views, 0)
      : null;
    const tasks = row.projectId ? ctx.tasks.get(row.projectId) ?? null : null;
    const card: WebsiteModuleCard = {
      module: toWebsiteModule(row),
      ownerName: row.ownerUserId ? ctx.people.get(row.ownerUserId) ?? null : null,
      leadAgentName: row.leadAgentId ? ctx.agentNames.get(row.leadAgentId) ?? null : null,
      pageCount: owned.length,
      openTasks: tasks?.open ?? null,
      needsPerson: tasks?.needsPerson ?? null,
      lastRelease,
      views,
      health: moduleHealth(lastRelease, views),
    };
    return { card, owned, pageIds, entryIds };
  }

  async function cards(site: SiteRow): Promise<WebsiteModuleCard[]> {
    const rows = await list(site.companyId, site.id);
    if (rows.length === 0) return [];
    const ctx = await context(site, rows);
    return rows.map((row) => cardFor(row, rows, ctx).card);
  }

  async function recentChanges(site: SiteRow, ids: string[]): Promise<WebsiteHomeActivity[]> {
    if (ids.length === 0) return [];
    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, site.companyId), like(activityLog.action, "website.%"), inArray(activityLog.entityId, ids)))
      .orderBy(desc(activityLog.createdAt))
      .limit(RECENT_CHANGES);
    const agentIds = [...new Set(events.filter((event) => event.actorType === "agent").map((event) => event.agentId ?? event.actorId))];
    const agentNames = new Map(
      (agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, site.companyId), inArray(agents.id, agentIds))) : [])
        .map((row) => [row.id, row.name]),
    );
    const userIds = [...new Set(events.filter((event) => event.actorType === "user").map((event) => event.actorId))];
    const people = new Map(
      (userIds.length ? await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)) : [])
        .map((row) => [row.id, row.name]),
    );
    const subjects = new Map<string, string>();
    for (const row of await db.select({ id: websitePage.id, title: websitePage.title }).from(websitePage).where(and(eq(websitePage.companyId, site.companyId), inArray(websitePage.id, ids)))) {
      subjects.set(row.id, row.title);
    }
    for (const row of await db.select({ id: websiteEntry.id, collection: websiteEntry.collection, key: websiteEntry.entryKey }).from(websiteEntry).where(and(eq(websiteEntry.companyId, site.companyId), inArray(websiteEntry.id, ids)))) {
      subjects.set(row.id, `${row.collection}/${row.key}`);
    }
    return events.map((event) => ({
      id: event.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      actorType: event.actorType,
      actorName: event.actorType === "agent"
        ? agentNames.get(event.agentId ?? event.actorId) ?? null
        : event.actorType === "user" ? people.get(event.actorId) ?? (event.actorId === "local-board" ? "Board" : null) : null,
      subject: subjects.get(event.entityId) ?? null,
      createdAt: event.createdAt.toISOString(),
    }));
  }

  async function detail(site: SiteRow, row: ModuleRow): Promise<WebsiteModuleDetail> {
    const rows = await list(site.companyId, site.id);
    const ctx = await context(site, rows);
    const { card, owned, pageIds, entryIds } = cardFor(rows.find((entry) => entry.id === row.id) ?? row, rows, ctx);
    return {
      ...card,
      pages: owned.map((page) => ({ id: page.id, slug: page.slug, title: page.title, status: page.status as WebsitePageStatus })),
      recentChanges: await recentChanges(site, [...pageIds, ...entryIds]),
    };
  }

  return { list, getRow, create, update, archive, addStartingSet, cards, detail };
}
