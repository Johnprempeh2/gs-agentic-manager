import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  NOTION_IMPORT_MAX_PAGES,
  ORGANISATION_STATUS_LABELS,
  type NotionImportPreview,
  type NotionImportResult,
} from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { organisationsApi } from "@/api/organisations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readZipTextFiles } from "@/lib/zip-text";
import { queryKeys } from "@/lib/queryKeys";
import { canRunPipedriveImport } from "./PipedriveImport";

type Page = { path: string; markdown: string };

const isMarkdown = (path: string) => /\.md$/i.test(path) && !path.split("/").some((part) => part.startsWith("__MACOSX"));

/** The Markdown pages in the chosen files: .md files as they are, and every .md inside a .zip. */
export async function pagesFromFiles(files: File[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const entries = await readZipTextFiles(await file.arrayBuffer(), isMarkdown);
      pages.push(...entries.map((entry) => ({ path: entry.path, markdown: entry.text })));
    } else if (isMarkdown(file.name)) {
      pages.push({ path: file.webkitRelativePath || file.name, markdown: await file.text() });
    }
  }
  return pages.slice(0, NOTION_IMPORT_MAX_PAGES);
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** What an import did, in one sentence. */
export function describeNotionResult(result: NotionImportResult) {
  const parts = [
    result.organisations.created ? `${plural(result.organisations.created, "client", "clients")} added` : null,
    result.organisations.updated ? `notes added to ${plural(result.organisations.updated, "client", "clients")}` : null,
    result.tasksCreated ? `${plural(result.tasksCreated, "task", "tasks")} made from to-dos` : null,
  ].filter(Boolean);
  return parts.length ? `Done: ${parts.join(", ")}.` : "Done. Everything was already imported.";
}

function NotionImportFlow({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [pages, setPages] = useState<Page[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<NotionImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [createTasks, setCreateTasks] = useState(true);
  const [result, setResult] = useState<NotionImportResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: (input: { pages: Page[]; createTasks: boolean }) => organisationsApi.previewNotionImport(companyId, input),
    onSuccess: (data) => {
      setPreview(data);
      setChosen(new Set(data.clients.map((client) => client.path)));
    },
  });
  const importMutation = useMutation({
    mutationFn: () => organisationsApi.importFromNotion(companyId, { pages: pages!, include: [...chosen], createTasks }),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  async function choose(files: FileList | null) {
    setReadError(null);
    setPreview(null);
    if (!files?.length) return;
    try {
      const found = await pagesFromFiles([...files]);
      if (found.length === 0) {
        setReadError("No Notion pages found. Export from Notion as Markdown & CSV and choose the .zip it gives you.");
        return;
      }
      setPages(found);
      previewMutation.mutate({ pages: found, createTasks });
    } catch (err) {
      setReadError((err as Error).message);
    }
  }

  if (result) {
    return (
      <div className="space-y-3 text-sm" role="status">
        <p>{describeNotionResult(result)}</p>
        <DialogFooter>
          <Button type="button" onClick={onClose}>Close</Button>
        </DialogFooter>
      </div>
    );
  }

  const error = readError ?? ((previewMutation.error ?? importMutation.error) as Error | null)?.message ?? null;
  const tasksChosen = (preview?.clients ?? [])
    .filter((client) => chosen.has(client.path))
    .reduce((total, client) => total + client.tasks.length, 0);

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <Label htmlFor="notion-import-file">Notion export</Label>
        <Input id="notion-import-file" type="file" accept=".zip,.md" multiple onChange={(event) => void choose(event.target.files)} />
        <p className="text-xs text-muted-foreground">
          In Notion, open your clients page, choose Export, pick Markdown &amp; CSV and include sub-pages. Choose the .zip
          here. Each client page becomes a client, sub-pages such as meeting notes join its notes, and unticked to-dos
          can become tasks.
        </p>
      </div>

      {previewMutation.isPending ? <p className="text-muted-foreground">Reading {plural(pages?.length ?? 0, "page", "pages")}…</p> : null}

      {preview ? (
        <div className="space-y-2">
          <p className="font-medium">
            Found {plural(preview.clients.length, "client", "clients")}
            {preview.skipped.length ? `, skipped ${plural(preview.skipped.length, "page", "pages")}` : ""}. Nothing is saved until you
            import.
          </p>
          {preview.clients.length > 0 ? (
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2" aria-label="Clients to import">
              {preview.clients.map((client) => (
                <li key={client.path}>
                  <label className="flex items-start gap-2">
                    <Checkbox
                      className="mt-0.5"
                      checked={chosen.has(client.path)}
                      onCheckedChange={(checked) =>
                        setChosen((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(client.path);
                          else next.delete(client.path);
                          return next;
                        })
                      }
                      aria-label={`Import ${client.name}`}
                    />
                    <span>
                      <span className="font-medium">{client.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {client.action === "create"
                          ? `New ${ORGANISATION_STATUS_LABELS[client.status].toLowerCase()}`
                          : client.notesChars > 0
                            ? "Already here: adds the Notion notes"
                            : "Already here: notes already imported"}
                        {createTasks && client.tasks.length ? `, ${plural(client.tasks.length, "task", "tasks")}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="flex items-center gap-2">
            <Checkbox checked={createTasks} onCheckedChange={(checked) => setCreateTasks(checked === true)} />
            Make a task for each unticked to-do{createTasks && tasksChosen ? ` (${tasksChosen})` : ""}
          </label>
          <p className="text-xs text-muted-foreground">Tasks stay unassigned, so no agent starts work until you give them out.</p>
        </div>
      ) : null}

      {error ? <p className="text-destructive" role="alert">{error}</p> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          type="button"
          disabled={!preview || chosen.size === 0 || importMutation.isPending}
          onClick={() => importMutation.mutate()}
        >
          {importMutation.isPending ? "Importing…" : `Import ${plural(chosen.size, "client", "clients")}`}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * "Import from Notion" on Organisations. Owners only. Works from a Notion
 * export, so no Notion key is needed and nothing is written to Notion. Shows
 * what will happen before anything is saved.
 */
export function NotionImport({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  if (!canRunPipedriveImport(companyId, access.data)) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Download />
        Import from Notion
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import client notes from Notion</DialogTitle>
              <DialogDescription>
                Brings your Notion client pages in as clients with their notes. You see the list first, and running it again
                adds nothing twice.
              </DialogDescription>
            </DialogHeader>
            <NotionImportFlow companyId={companyId} onClose={() => setOpen(false)} />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
