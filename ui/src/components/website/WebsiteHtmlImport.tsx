import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WebsiteHtmlImportResult, WebsiteSite } from "@greatstone/shared";
import { ApiError } from "../../api/client";
import { websiteModuleApi } from "../../api/website";
import { Button } from "@/components/ui/button";
import { errorStateMessage } from "../ErrorState";

// Import HTML (GRE-3993): a person brings the site's schema 2 release file
// (greatstone-website's export, GRE-3778) in as draft pages. Nothing is published.

/** Same cap as the server's JSON body limit. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Reads the chosen file and checks it looks like a schema 2 release before it is sent. */
export async function readReleaseFile(file: File): Promise<unknown> {
  if (file.size > MAX_FILE_BYTES) throw new Error("This file is over 10 MB. GSAM cannot import a file this big.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not JSON. Choose the release file the site export wrote, for example html-export-release.json.");
  }
  const release = parsed as { schema?: unknown; pages?: unknown } | null;
  if (!release || typeof release !== "object" || release.schema !== 2) {
    throw new Error("This is not a release file of schema 2. Export the site again and choose html-export-release.json.");
  }
  if (!Array.isArray(release.pages) || release.pages.length === 0) {
    throw new Error("This release file has no pages.");
  }
  return parsed;
}

/** The refusal in plain words: what is wrong with the file, or why GSAM said no. */
export function importErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) {
      const issue = (error.body as { details?: Array<{ path?: unknown[]; message?: string }> } | null)?.details?.[0];
      const where = Array.isArray(issue?.path) && issue.path.length ? ` (${issue.path.join(".")}: ${issue.message ?? "not valid"})` : "";
      return `The file does not match the release format${where}. Export the site again and choose the new file.`;
    }
    if (error.status === 413) return "This file is over 10 MB. GSAM cannot import a file this big.";
    if (error.status === 403) return "Only a person with Publish rights can import HTML.";
  }
  return errorStateMessage(error);
}

const pages = (count: number) => `${count} ${count === 1 ? "page" : "pages"}`;

function ImportSummary({ result }: { result: WebsiteHtmlImportResult }) {
  const drafts = result.created.length + result.updated.length;
  return (
    <div role="status" className="space-y-0.5 text-xs" data-testid="website-html-import-result">
      <p className="font-medium text-foreground">
        {drafts === 0 ? "No page changed. Every page already matches this file." : `${pages(drafts)} became drafts.`}
      </p>
      {drafts > 0 ? (
        <p className="text-muted-foreground">
          {result.created.length} new, {result.updated.length} changed, {result.unchanged.length} unchanged.
          {result.redirects.length ? ` ${result.redirects.length} old addresses get a draft redirect.` : ""}
          {result.chrome.length ? ` Shared parts updated: ${result.chrome.join(", ")}.` : ""}
        </p>
      ) : null}
      <p className="text-muted-foreground">Nothing is published. Review the drafts on the Sitemap tab, then Publish.</p>
    </div>
  );
}

/** Import HTML on a connected site, for people with Publish rights. */
export function WebsiteHtmlImport({ companyId, site }: { companyId: string; site: WebsiteSite }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: async (chosen: File) => websiteModuleApi.importHtml(companyId, site.id, await readReleaseFile(chosen)),
    onSuccess: () => {
      // Pages, sitemap, home and chrome all read the new drafts.
      void queryClient.invalidateQueries({ queryKey: ["website", companyId] });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    },
  });
  const inputId = `website-html-import-${site.id}`;

  return (
    <div className="space-y-2 border-t border-border/60 pt-3" data-testid="website-html-import">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Import HTML</p>
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          Bring the site's pages in from its release file (schema 2, for example html-export-release.json). Each page becomes a draft on {site.name}. Nothing is published.
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (file) run.mutate(file);
        }}
      >
        <label htmlFor={inputId} className="sr-only">Release file</label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".json,application/json"
          aria-describedby={`${inputId}-help`}
          disabled={run.isPending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            run.reset();
          }}
          className="min-w-0 max-w-full text-xs file:mr-2 file:rounded-md file:border file:border-border file:bg-transparent file:px-2 file:py-1 file:text-xs file:font-medium"
        />
        <Button type="submit" size="sm" disabled={!file || run.isPending}>
          {run.isPending ? "Importing" : "Import HTML"}
        </Button>
      </form>
      {run.isError ? (
        <p role="alert" className="text-xs text-status-danger">{importErrorMessage(run.error)}</p>
      ) : run.data ? (
        <ImportSummary result={run.data} />
      ) : null}
    </div>
  );
}
