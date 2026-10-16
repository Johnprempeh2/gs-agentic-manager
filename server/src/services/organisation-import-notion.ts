// Notion import for client notes. Works from the Markdown files of a Notion
// export ("Export > Markdown & CSV"), so no Notion key is needed and nothing
// is written to Notion. Each top-level page becomes a client (an organisation);
// sub-pages such as meeting notes join their parent's notes; unticked to-dos
// become tasks. A preview says what would happen before anything is written,
// and a rerun adds nothing twice.
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues, organisations } from "@greatstone/db";
import type {
  ImportNotion,
  NotionImportClient,
  NotionImportPreview,
  NotionImportResult,
  OrganisationStatus,
} from "@greatstone/shared";
import { issueService } from "./issues.js";

const SOURCE = "notion";
const TASK_ORIGIN_KIND = "notion_import";
const NOTES_MAX_CHARS = 20_000;
const TASK_TITLE_MAX = 200;

export interface ParsedNotionPage {
  path: string;
  /** Path without `.md`: sub-pages live in a folder with this name. */
  key: string;
  title: string;
  /** The 32 character id Notion adds to file names, when present. */
  notionId: string | null;
  properties: Record<string, string>;
  body: string;
  todos: string[];
}

function stripNotionId(name: string) {
  const match = name.match(/^(.*?)\s+([0-9a-f]{32})$/i);
  return match ? { name: match[1]!.trim(), id: match[2]!.toLowerCase() } : { name: name.trim(), id: null };
}

/** Reads one exported page: title, the property lines under it, body text and unticked to-dos. */
export function parseNotionPage(path: string, markdown: string): ParsedNotionPage {
  const key = path.replace(/\\/g, "/").replace(/\.md$/i, "");
  const fileName = key.split("/").pop() ?? key;
  const fromFile = stripNotionId(fileName);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  let title = fromFile.name;
  const heading = lines[index]?.match(/^#\s+(.+)$/);
  if (heading) {
    title = heading[1]!.trim();
    index += 1;
  }
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  const properties: Record<string, string> = {};
  while (index < lines.length) {
    const property = lines[index]!.match(/^([A-Za-z][^:\n]{0,39}):\s+(.+)$/);
    if (!property || /^https?$/i.test(property[1]!)) break;
    properties[property[1]!.trim().toLowerCase()] = property[2]!.trim();
    index += 1;
  }
  const rest = lines.slice(index);
  const todos = rest
    .map((line) => line.match(/^\s*[-*]\s+\[ \]\s+(.+)$/)?.[1]?.trim())
    .filter((text): text is string => Boolean(text));
  const body = rest.join("\n").trim();
  return { path, key, title, notionId: fromFile.id, properties, body, todos };
}

/** Maps a Notion status or stage to a client stage. Clients are the default, as these are client notes. */
export function stageFromNotion(value: string | undefined): OrganisationStatus {
  const text = (value ?? "").toLowerCase();
  if (/former|churn|lost|past|inactive|ended|closed/.test(text)) return "former";
  if (/prospect|lead|pipeline|proposal|negotiat|qualif|pitch|discovery/.test(text)) return "prospect";
  if (/target|cold|research/.test(text)) return "target";
  return "client";
}

/** True when a page holds nothing but links to other pages, such as a section's index page. */
function onlyLinks(page: ParsedNotionPage) {
  if (Object.keys(page.properties).length > 0 || page.todos.length > 0) return false;
  const text = page.body
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[|\-:#>*\s]/g, "");
  return text.length === 0;
}

interface ClientDraft {
  page: ParsedNotionPage;
  name: string;
  status: OrganisationStatus;
  notes: string;
  todos: string[];
}

/** Groups pages into clients: top-level pages are clients, and a page in a client's folder joins that client. */
export function groupNotionPages(pages: Array<{ path: string; markdown: string }>) {
  const parsed = pages
    .filter((page) => /\.md$/i.test(page.path))
    .map((page) => parseNotionPage(page.path, page.markdown));
  const byKey = new Map(parsed.map((page) => [page.key, page]));
  const skipped: Array<{ path: string; reason: string }> = pages
    .filter((page) => !/\.md$/i.test(page.path))
    .map((page) => ({ path: page.path, reason: "Not a Markdown page" }));

  /** The outermost page this page sits inside, if any. */
  const rootOf = (page: ParsedNotionPage) => {
    const parts = page.key.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const candidate = byKey.get(parts.slice(0, length).join("/"));
      if (candidate && !onlyLinks(candidate)) return candidate;
    }
    return null;
  };

  const clients = new Map<string, ClientDraft>();
  const children: ParsedNotionPage[] = [];
  for (const page of parsed) {
    if (rootOf(page)) {
      children.push(page);
      continue;
    }
    if (!page.title) {
      skipped.push({ path: page.path, reason: "No title" });
      continue;
    }
    if (onlyLinks(page)) {
      skipped.push({ path: page.path, reason: "Only links to other pages" });
      continue;
    }
    clients.set(page.key, {
      page,
      name: page.title.slice(0, 200),
      status: stageFromNotion(page.properties.status ?? page.properties.stage ?? page.properties.type),
      notes: page.body,
      todos: [...page.todos],
    });
  }
  for (const page of children) {
    const client = clients.get(rootOf(page)!.key);
    if (!client) continue;
    if (page.body) client.notes = `${client.notes}\n\n## ${page.title}\n\n${page.body}`.trim();
    client.todos.push(...page.todos);
  }
  for (const client of clients.values()) client.todos = [...new Set(client.todos)];
  return { clients: [...clients.values()], skipped };
}

function nameKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function fingerprint(text: string) {
  return createHash("sha256").update(nameKey(text)).digest("hex").slice(0, 32);
}

/** Notes with an import block added, kept within the notes limit; unchanged when the block is already there. */
export function mergeNotes(existing: string | null, imported: string, date: string) {
  const text = imported.trim();
  if (!text) return existing;
  if (existing?.includes(text.slice(0, 200))) return existing;
  const block = `Imported from Notion on ${date}\n\n${text}`;
  const merged = existing?.trim() ? `${existing.trim()}\n\n---\n${block}` : block;
  if (merged.length <= NOTES_MAX_CHARS) return merged;
  const cut = "\n\n(Cut short here. The rest is in Notion.)";
  return `${merged.slice(0, NOTES_MAX_CHARS - cut.length)}${cut}`;
}

export interface NotionImportActor {
  userId: string | null;
  agentId: string | null;
}

export function notionImportService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const issuesSvc = issueService(db);

  async function plan(companyId: string, body: ImportNotion) {
    const grouped = groupNotionPages(body.pages);
    const include = body.include ? new Set(body.include) : null;
    const existing = await db
      .select()
      .from(organisations)
      .where(and(eq(organisations.companyId, companyId), isNull(organisations.archivedAt)));
    const byNotionId = new Map(existing.filter((row) => row.source === SOURCE && row.externalId).map((row) => [row.externalId!, row]));
    const byName = new Map(existing.map((row) => [nameKey(row.name), row]));

    const done = new Set<string>();
    if (existing.length > 0) {
      const imported = await db
        .select({ originId: issues.originId, originFingerprint: issues.originFingerprint })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, TASK_ORIGIN_KIND)));
      for (const row of imported) done.add(`${row.originId}:${row.originFingerprint}`);
    }

    const date = now().toISOString().slice(0, 10);
    const rows = grouped.clients
      .filter((client) => !include || include.has(client.page.path))
      .map((client) => {
        const match = (client.page.notionId ? byNotionId.get(client.page.notionId) : undefined) ?? byName.get(nameKey(client.name)) ?? null;
        const notes = mergeNotes(match?.notes ?? null, client.notes, date);
        const tasks = body.createTasks
          ? client.todos.filter((todo) => !match || !done.has(`${match.id}:${fingerprint(todo)}`))
          : [];
        const preview: NotionImportClient = {
          path: client.page.path,
          name: client.name,
          status: match ? (match.status as OrganisationStatus) : client.status,
          action: match ? "update" : "create",
          organisationId: match?.id ?? null,
          notesChars: notes === (match?.notes ?? null) ? 0 : (notes?.length ?? 0) - (match?.notes?.length ?? 0),
          tasks,
        };
        return { client, match, notes, preview };
      });
    return { rows, skipped: grouped.skipped };
  }

  return {
    async preview(companyId: string, body: ImportNotion): Promise<NotionImportPreview> {
      const { rows, skipped } = await plan(companyId, body);
      return { clients: rows.map((row) => row.preview), skipped };
    },

    async run(companyId: string, body: ImportNotion, actor: NotionImportActor): Promise<NotionImportResult> {
      const { rows, skipped } = await plan(companyId, body);
      const result: NotionImportResult = {
        clients: [],
        skipped,
        organisations: { created: 0, updated: 0 },
        tasksCreated: 0,
      };
      for (const row of rows) {
        let organisationId = row.match?.id ?? null;
        if (row.match) {
          if (row.notes !== row.match.notes) {
            await db
              .update(organisations)
              .set({ notes: row.notes, updatedAt: now() })
              .where(eq(organisations.id, row.match.id));
            result.organisations.updated += 1;
          }
        } else {
          const props = row.client.page.properties;
          const [created] = await db
            .insert(organisations)
            .values({
              companyId,
              name: row.client.name,
              status: row.client.status,
              notes: row.notes,
              website: props.website ?? props.url ?? null,
              industry: props.industry ?? props.sector ?? null,
              country: props.country ?? props.location ?? null,
              source: SOURCE,
              externalId: row.client.page.notionId,
              createdByUserId: actor.userId,
              createdByAgentId: actor.agentId,
            })
            .returning();
          organisationId = created!.id;
          result.organisations.created += 1;
        }
        for (const todo of row.preview.tasks) {
          await issuesSvc.create(companyId, {
            title: `${row.client.name}: ${todo}`.slice(0, TASK_TITLE_MAX),
            description: `From the Notion notes for ${row.client.name}.`,
            status: "todo",
            priority: "medium",
            responsibleUserId: actor.userId,
            createdByUserId: actor.userId,
            originKind: TASK_ORIGIN_KIND,
            originId: organisationId,
            originFingerprint: fingerprint(todo),
          } as Parameters<typeof issuesSvc.create>[1]);
          result.tasksCreated += 1;
        }
        result.clients.push({ ...row.preview, organisationId });
      }
      return result;
    },
  };
}
