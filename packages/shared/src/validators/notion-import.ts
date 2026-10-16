import { z } from "zod";
import type { OrganisationStatus } from "../organisations.js";

/** Most pages and characters one Notion import may carry. */
export const NOTION_IMPORT_MAX_PAGES = 1000;
export const NOTION_IMPORT_MAX_PAGE_CHARS = 200_000;
export const NOTION_IMPORT_MAX_TOTAL_CHARS = 8_000_000;

const notionPageSchema = z
  .object({
    /** Path inside the export, such as `Clients/Kente Logistics 1a2b….md`. */
    path: z.string().trim().min(1).max(500),
    markdown: z.string().max(NOTION_IMPORT_MAX_PAGE_CHARS, "A page is too large to import"),
  })
  .strict();

/**
 * Body of POST .../organisations/import/notion: the Markdown pages of a Notion
 * export. `preview` changes nothing and says what would happen; `import` does it.
 */
export const importNotionSchema = z
  .object({
    mode: z.enum(["preview", "import"]),
    pages: z.array(notionPageSchema).min(1, "Add at least one Notion page").max(NOTION_IMPORT_MAX_PAGES),
    /** Paths to import. Leave out to import every client the preview found. */
    include: z.array(z.string().max(500)).max(NOTION_IMPORT_MAX_PAGES).optional(),
    /** Make a task for each unticked to-do on a page. */
    createTasks: z.boolean().default(true),
  })
  .strict()
  .refine((body) => body.pages.reduce((total, page) => total + page.markdown.length, 0) <= NOTION_IMPORT_MAX_TOTAL_CHARS, {
    message: "This export is too large. Export the clients section on its own.",
  });
export type ImportNotion = z.infer<typeof importNotionSchema>;

export interface NotionImportClient {
  path: string;
  name: string;
  /** Stage the client gets when it is new; an existing client keeps its stage. */
  status: OrganisationStatus;
  action: "create" | "update";
  organisationId: string | null;
  /** Characters of notes added to the client. */
  notesChars: number;
  /** Unticked to-dos that become tasks (ones already imported are left out). */
  tasks: string[];
}

export interface NotionImportPreview {
  clients: NotionImportClient[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface NotionImportResult extends NotionImportPreview {
  organisations: { created: number; updated: number };
  tasksCreated: number;
}
