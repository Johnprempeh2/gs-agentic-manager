import { Command } from "commander";
import { COMPANY_SEARCH_SCOPES, type CompanySearchResponse, type CompanySearchResult } from "@greatstone/shared";
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

export function registerSearchCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("search")
      .description("Search the company: tasks, comments, docs, uploaded files, clients, people, deals, Pipedrive notes and images")
      .argument("<query...>", "Words to search for")
      .option("-C, --company-id <id>", "Company ID")
      .option("--scope <scope>", `Where to look: ${COMPANY_SEARCH_SCOPES.join(", ")}`, "all")
      .option("--limit <n>", "Most results to return (1 to 50)", "10")
      .action(async (words: string[], opts: SearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const scope = opts.scope ?? "all";
          if (!(COMPANY_SEARCH_SCOPES as readonly string[]).includes(scope)) {
            throw new Error(`--scope must be one of: ${COMPANY_SEARCH_SCOPES.join(", ")}`);
          }
          const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? "10", 10) || 10, 1), 50);
          const params = new URLSearchParams({ q: words.join(" "), scope, limit: String(limit) });
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
