import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  LINK_STATUSES,
  LINK_TYPES,
  type LinkItem,
  type LinksImportResult,
  type LinksResponse,
} from "@greatstone/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface LinksSearchOptions extends BaseClientOptions {
  client?: string;
  project?: string;
  type?: string;
  status?: string;
  archived?: boolean;
}

interface LinksAddOptions extends BaseClientOptions {
  url: string;
  title: string;
  type?: string;
  status?: string;
  client?: string;
  project?: string;
  issue?: string;
  notes?: string;
  deployed?: string;
}

interface LinksImportOptions extends BaseClientOptions {
  file: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (!value) return undefined;
  const wanted = value.trim().toLowerCase() as T;
  if (!allowed.includes(wanted)) throw new Error(`Unknown ${flag} "${value}". Use one of: ${allowed.join(", ")}`);
  return wanted;
}

function row(link: LinkItem) {
  return {
    title: link.title,
    url: link.url,
    client: link.clientCase?.name ?? link.clientName ?? "",
    project: link.project?.name ?? link.projectName ?? "",
    type: link.type,
    status: link.status,
    task: link.sourceIssue?.identifier ?? "",
  };
}

/**
 * The links register (GRE-4252). Deliverables and previews with a web address
 * are filed automatically; use `add` for anything else you share.
 */
export function registerLinksCommands(program: Command): void {
  const links = program
    .command("links")
    .description("The links register: every shared link (sites, portals, previews, decks), by client and project");

  addCommonClientOptions(
    links
      .command("search")
      .description("Search links by title, URL, client, project, task or notes")
      .argument("[query]", "Words or part of a URL")
      .option("--client <caseId>", "Only this client's links (client case id)")
      .option("--project <projectId>", "Only this project's links")
      .option("--type <type>", `One of: ${LINK_TYPES.join(", ")}`)
      .option("--status <status>", `One of: ${LINK_STATUSES.join(", ")}`)
      .option("--archived", "Include archived links")
      .action(async (query: string | undefined, opts: LinksSearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (query?.trim()) params.set("q", query.trim());
          if (opts.client) params.set("clientCaseId", opts.client);
          if (opts.project) params.set("projectId", opts.project);
          const type = oneOf(opts.type, LINK_TYPES, "--type");
          const status = oneOf(opts.status, LINK_STATUSES, "--status");
          if (type) params.set("type", type);
          if (status) params.set("status", status);
          if (opts.archived) params.set("includeArchived", "true");
          const search = params.toString();
          const response = await ctx.api.get<LinksResponse>(
            `${apiPath`/api/companies/${ctx.companyId}/links`}${search ? `?${search}` : ""}`,
          );
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          printOutput((response?.links ?? []).map(row));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    links
      .command("add")
      .description("Add a link, or update it if the URL is already registered")
      .requiredOption("--url <url>", "The https:// address")
      .requiredOption("--title <title>", "What it is, such as \"Acme proposal site\"")
      .option("--type <type>", `One of: ${LINK_TYPES.join(", ")}`)
      .option("--status <status>", `One of: ${LINK_STATUSES.join(", ")} (default live)`)
      .option("--client <caseId>", "Client case id (default: the task's client)")
      .option("--project <projectId>", "Project id (default: the task's project)")
      .option("--issue <issueId>", "Source task id (default: $GSAM_TASK_ID)")
      .option("--notes <text>", "Anything worth knowing, such as who it was sent to")
      .option("--deployed <date>", "Deploy or created date, such as 2026-11-06")
      .action(async (opts: LinksAddOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const issueId = opts.issue?.trim() || process.env.GSAM_TASK_ID?.trim() || undefined;
          if (issueId && !UUID.test(issueId)) throw new Error("--issue must be the task's id (a UUID), not its identifier");
          const saved = await ctx.api.post<LinkItem>(apiPath`/api/companies/${ctx.companyId}/links`, {
            url: opts.url,
            title: opts.title,
            ...(opts.type ? { type: oneOf(opts.type, LINK_TYPES, "--type") } : {}),
            ...(opts.status ? { status: oneOf(opts.status, LINK_STATUSES, "--status") } : {}),
            ...(opts.client ? { clientCaseId: opts.client } : {}),
            ...(opts.project ? { projectId: opts.project } : {}),
            ...(issueId ? { sourceIssueId: issueId } : {}),
            ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
            ...(opts.deployed?.trim() ? { deployedAt: opts.deployed.trim() } : {}),
          });
          if (ctx.json) {
            printOutput(saved, { json: true });
            return;
          }
          printOutput(saved ? row(saved) : null);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    links
      .command("import")
      .description("Import a CSV export of the Notion link register (Name, Client, Project, Type, Status, URL, Deploy Date, Notes)")
      .requiredOption("--file <path>", "The CSV file")
      .action(async (opts: LinksImportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const csv = await readFile(opts.file, "utf8");
          const result = await ctx.api.post<LinksImportResult>(apiPath`/api/companies/${ctx.companyId}/links/import`, { csv });
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
