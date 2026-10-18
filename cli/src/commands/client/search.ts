import { Command } from "commander";
import {
  COMPANY_SEARCH_RECORD_KINDS,
  COMPANY_SEARCH_SCOPES,
  type CompanyQuietClient,
  type CompanyQuietClientsResponse,
  type CompanySearchResponse,
  type CompanySearchResult,
} from "@greatstone/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SearchOptions extends BaseClientOptions {
  companyId?: string;
  scope?: string;
  limit?: string;
  kind?: string;
}

/** What kind of thing a result is, in plain words: "Task", "Organisation", "In file". */
export function searchResultKind(result: CompanySearchResult): string {
  if (result.type === "record" && result.record) {
    const kind = result.record.kind;
    if (kind === "activity") return "Note or activity";
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  if (result.type === "file") return "In file";
  if (result.type === "issue") return "Task";
  return result.sourceLabel || result.type.charAt(0).toUpperCase() + result.type.slice(1);
}

/** One result as two short lines: what and where, then the matching text. */
export function formatSearchResult(result: CompanySearchResult): string {
  const identifier = result.issue?.identifier;
  const name = identifier && !result.title.startsWith(identifier) ? `${identifier} ${result.title}` : result.title;
  const detail = result.record?.subtitle ?? result.file?.owner.label ?? null;
  const head = [searchResultKind(result), name, detail].filter(Boolean).join(" | ");
  const snippet = result.snippet?.replace(/\s+/g, " ").trim();
  return [`${head}  ${result.href}`, snippet ? `    ${snippet}` : null].filter(Boolean).join("\n");
}

/** One quiet deal: name, stage, how long since we last spoke, and its link. */
export function formatQuietClient(client: CompanyQuietClient): string {
  const days = `${client.quietDays} ${client.quietDays === 1 ? "day" : "days"}`;
  const last = client.lastTouchAt ? `last ${client.lastTouchLabel ?? "contact"}, ${days} ago` : `no notes or calls yet, added ${days} ago`;
  const name = client.organisationName && !client.title.includes(client.organisationName)
    ? `${client.title} (${client.organisationName})`
    : client.title;
  return `${name} | ${client.stageName} in ${client.pipelineName} | ${last}  ${client.href}`;
}

interface QuietClientsOptions extends BaseClientOptions {
  companyId?: string;
  days?: string;
  limit?: string;
}

export function registerSearchCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("quiet-clients")
      .description("Open deals and leads with no note, call, meeting or email for a while, quietest first")
      .option("-C, --company-id <id>", "Company ID")
      .option("--days <n>", "Days without contact (1 to 365)", "30")
      .option("--limit <n>", "Most deals to list (1 to 50)", "10")
      .action(async (opts: QuietClientsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const days = Math.min(Math.max(Number.parseInt(opts.days ?? "30", 10) || 30, 1), 365);
          const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? "10", 10) || 10, 1), 50);
          const params = new URLSearchParams({ days: String(days), limit: String(limit) });
          const response = await ctx.api.get<CompanyQuietClientsResponse>(
            `/api/companies/${encodeURIComponent(ctx.companyId!)}/search/quiet-clients?${params.toString()}`,
          );
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          const clients = response?.clients ?? [];
          if (clients.length === 0) {
            console.log(`Every open deal and lead has had a note, call or meeting in the last ${days} days.`);
            return;
          }
          console.log(`${response!.total} open deals and leads with no note, call or meeting in ${days} days:`);
          for (const client of clients) console.log(formatQuietClient(client));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );


  addCommonClientOptions(
    program
      .command("search")
      .description("Search the company: tasks, comments, docs, uploaded files, clients, people, deals, Pipedrive notes and images")
      .argument("<query...>", "Words to search for")
      .option("-C, --company-id <id>", "Company ID")
      .option("--scope <scope>", `Where to look: ${COMPANY_SEARCH_SCOPES.join(", ")}`, "all")
      .option("--limit <n>", "Most results to return (1 to 50)", "10")
      .option("--kind <kinds>", `Only these records, comma separated: ${COMPANY_SEARCH_RECORD_KINDS.join(", ")} (implies --scope records)`)
      .action(async (words: string[], opts: SearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const kinds = (opts.kind ?? "").split(",").map((kind) => kind.trim()).filter(Boolean);
          const unknownKind = kinds.find((kind) => !(COMPANY_SEARCH_RECORD_KINDS as readonly string[]).includes(kind));
          if (unknownKind) {
            throw new Error(`--kind must be one or more of: ${COMPANY_SEARCH_RECORD_KINDS.join(", ")}`);
          }
          const scope = kinds.length > 0 && (opts.scope ?? "all") === "all" ? "records" : opts.scope ?? "all";
          if (!(COMPANY_SEARCH_SCOPES as readonly string[]).includes(scope)) {
            throw new Error(`--scope must be one of: ${COMPANY_SEARCH_SCOPES.join(", ")}`);
          }
          const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? "10", 10) || 10, 1), 50);
          const params = new URLSearchParams({ q: words.join(" "), scope, limit: String(limit) });
          if (kinds.length > 0) params.set("recordKind", kinds.join(","));
          const response = await ctx.api.get<CompanySearchResponse>(
            `/api/companies/${encodeURIComponent(ctx.companyId!)}/search?${params.toString()}`,
          );
          const results = response?.results ?? [];
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          if (results.length === 0) {
            console.log(`Nothing found for "${words.join(" ")}".`);
            return;
          }
          for (const result of results) console.log(formatSearchResult(result));
          if (response?.hasMore) console.log(`More results: raise --limit or narrow --scope.`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
