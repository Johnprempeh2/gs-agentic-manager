import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import type { ImportPipedriveExport, OrganisationImportCounts, OrganisationImportResult, ToolConnection } from "@greatstone/shared";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { organisationsApi } from "@/api/organisations";
import { pipelinesApi } from "@/api/pipelines";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { appSourceConnectHref } from "@/pages/apps/app-connect-policy";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

/** Client mirror of the import route's guard: owner only (admins cannot run it). The server stays authoritative. */
export function canRunPipedriveImport(companyId: string, access: CurrentBoardAccess | undefined) {
  if (!access) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  const membership = access.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return membership?.membershipRole === "owner";
}

/** The company's working Pipedrive connection from Apps, if any. */
export function activePipedriveConnection(connections: ToolConnection[]) {
  return connections.find((connection) =>
    (connection.config ?? connection.transportConfig)?.sourceTemplateKey === "pipedrive"
    && connection.status === "active"
    && connection.enabled,
  ) ?? null;
}

function countsText(label: string, counts: OrganisationImportCounts) {
  return `${label}: ${counts.created} added, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.errors} failed`;
}

const SAMPLE_LABELS: Record<OrganisationImportResult["errorSamples"][number]["kind"], string> = {
  organisation: "Organisation",
  contact: "Person",
  deal: "Deal",
  activity: "Activity",
  pipeline: "Pipeline",
  note: "Note",
  call: "Call",
  email: "Email",
  product: "Product",
  lead: "Lead",
};

/** One CRM's export files and where they go, so the upload form serves Pipedrive and HubSpot alike. */
export interface CrmExportSpec {
  /** Prefix for input ids, such as `pipedrive-export`. */
  idPrefix: string;
  instructions: string;
  files: Array<{ kind: string; label: string; hint: string }>;
  /** The file kind that holds deals, which needs a pipeline. */
  dealsKind: string;
  submit: (companyId: string, body: Record<string, string>) => Promise<OrganisationImportResult>;
}

const EXPORT_FILES: CrmExportSpec["files"] = [
  { kind: "organisations", label: "Organisations", hint: "Becomes your organisations list." },
  { kind: "people", label: "People", hint: "Added to the organisation they work for." },
  { kind: "deals", label: "Deals", hint: "Open deals become client cases; won deals mark the organisation as a client." },
  { kind: "activities", label: "Activities", hint: "Calls, meetings and tasks, attached to their deal." },
];

const PIPEDRIVE_EXPORT: CrmExportSpec = {
  idPrefix: "pipedrive-export",
  instructions:
    "In Pipedrive, open each list, choose the three dots menu, then Export as CSV. Add the files you have; you can add the rest later.",
  files: EXPORT_FILES,
  dealsKind: "deals",
  submit: (companyId, body) => organisationsApi.importFromPipedriveExport(companyId, body as ImportPipedriveExport),
};

/**
 * "Import from Pipedrive" on Organisations (GRE-1479). Owners only. Two ways
 * in: upload the CSV files Pipedrive exports (no API key needed), or run the
 * read-only import through a working Pipedrive connection from Apps.
 */
export function PipedriveImport({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isOwner = canRunPipedriveImport(companyId, access.data);
  if (!isOwner) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Download />
        Import from Pipedrive
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <PipedriveImportDialogContent companyId={companyId} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

export function ImportResultSummary({ result }: { result: OrganisationImportResult }) {
  return (
    <div className="space-y-2 text-sm" role="status">
      <p className="font-medium">Import finished.</p>
      <ul className="space-y-1">
        <li>{countsText("Organisations", result.organisations)}</li>
        <li>{countsText("People", result.contacts)}</li>
        {result.pipelines ? <li>{countsText("Pipelines", result.pipelines)}</li> : null}
        {result.deals ? <li>{countsText("Deals", result.deals)}</li> : null}
        {result.activities ? <li>{countsText("Activities", result.activities)}</li> : null}
        {result.notes ? <li>{countsText("Notes", result.notes)}</li> : null}
        {result.calls ? <li>{countsText("Calls", result.calls)}</li> : null}
        {result.emails ? <li>{countsText("Emails", result.emails)}</li> : null}
        {result.stageChanges ? <li>{countsText("Stage changes", result.stageChanges)}</li> : null}
        {result.products ? <li>{countsText("Products", result.products)}</li> : null}
        {result.dealProducts ? <li>{countsText("Products on deals", result.dealProducts)}</li> : null}
        {result.leads ? <li>{countsText("Leads", result.leads)}</li> : null}
      </ul>
      {result.errorSamples.length > 0 ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs text-muted-foreground" aria-label="Import errors">
          {result.errorSamples.map((sample) => (
            <li key={`${sample.kind}-${sample.externalId}`}>
              {SAMPLE_LABELS[sample.kind]} {sample.externalId}: {sample.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PipedriveImportDialogContent({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const connection = activePipedriveConnection(connections.data?.connections ?? []);
  const [chosenMode, setMode] = useState<"file" | "api" | null>(null);
  const mode = chosenMode ?? (connection ? "api" : "file");

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Import from Pipedrive</DialogTitle>
        <DialogDescription>
          Brings your Pipedrive organisations, people, deals and activities into GSAM. Nothing is written to Pipedrive,
          and running it again updates what it imported before instead of adding duplicates.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2" role="group" aria-label="How to import">
        <Button type="button" size="sm" variant={mode === "file" ? "default" : "outline"} aria-pressed={mode === "file"} onClick={() => setMode("file")}>
          Upload export files
        </Button>
        <Button type="button" size="sm" variant={mode === "api" ? "default" : "outline"} aria-pressed={mode === "api"} onClick={() => setMode("api")}>
          Use my Pipedrive connection
        </Button>
      </div>
      {mode === "file" ? (
        <ExportFileImport companyId={companyId} onClose={onClose} />
      ) : (
        <ConnectionImport companyId={companyId} onClose={onClose} connections={connections} connection={connection} />
      )}
    </DialogContent>
  );
}

export function ExportFileImport({
  companyId,
  onClose,
  spec = PIPEDRIVE_EXPORT,
}: {
  companyId: string;
  onClose: () => void;
  spec?: CrmExportSpec;
}) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const dealsFile = files[spec.dealsKind];
  const [pipelineId, setPipelineId] = useState("");
  const pipelines = useQuery({
    queryKey: queryKeys.pipelines.list(companyId),
    queryFn: () => pipelinesApi.list(companyId),
    enabled: Boolean(dealsFile),
  });
  const livePipelines = (pipelines.data ?? []).filter((pipeline) => !pipeline.archivedAt);
  const run = useMutation<OrganisationImportResult, Error>({
    mutationFn: async () => {
      const body: Record<string, string> = {};
      for (const { kind } of spec.files) {
        const file = files[kind];
        if (file) body[kind] = await file.text();
      }
      if (pipelineId) body.pipelineId = pipelineId;
      return spec.submit(companyId, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
    },
  });
  const hasFile = Object.values(files).some(Boolean);
  const needsPipeline = Boolean(dealsFile) && !pipelineId;

  return (
    <>
      {run.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Importing your files.
        </p>
      ) : run.data ? (
        <ImportResultSummary result={run.data} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{spec.instructions}</p>
          {spec.files.map(({ kind, label, hint }) => (
            <div key={kind} className="space-y-1">
              <Label htmlFor={`${spec.idPrefix}-${kind}`}>{label}</Label>
              <Input
                id={`${spec.idPrefix}-${kind}`}
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setFiles((current) => ({ ...current, [kind]: file }));
                }}
              />
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          {dealsFile ? (
            <div className="space-y-1">
              <Label htmlFor={`${spec.idPrefix}-pipeline`}>Pipeline for open deals</Label>
              <NativeSelect id={`${spec.idPrefix}-pipeline`} value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>
                <option value="">Choose a pipeline</option>
                {livePipelines.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">Deals land in the stage with the same name, or the first stage.</p>
            </div>
          ) : null}
        </div>
      )}

      {run.error ? <p className="text-sm text-destructive" role="alert">{run.error.message}</p> : null}

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{run.data ? "Done" : "Cancel"}</Button>
        {run.data ? null : (
          <Button type="button" disabled={!hasFile || needsPipeline || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Importing…" : "Import files"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function ConnectionImport({
  companyId,
  onClose,
  connections,
  connection,
}: {
  companyId: string;
  onClose: () => void;
  connections: { isLoading: boolean; error: Error | null };
  connection: ToolConnection | null;
}) {
  const queryClient = useQueryClient();
  const run = useMutation<OrganisationImportResult, Error>({
    mutationFn: () => organisationsApi.importFromPipedrive(companyId, connection!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) }),
  });
  const result = run.data;

  return (
    <>
      {connections.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking for a Pipedrive connection…</p>
      ) : connections.error ? (
        <p className="text-sm text-destructive" role="alert">Could not check your connections. {connections.error.message}</p>
      ) : !connection ? (
        <p className="text-sm">
          Connect Pipedrive in Apps first, using the personal API token from Settings &gt; Personal preferences &gt; API in Pipedrive.
          Until then, upload export files instead.
        </p>
      ) : run.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Importing from Pipedrive. Large accounts can take a minute.
        </p>
      ) : result ? (
        <ImportResultSummary result={result} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Reads every organisation, person, deal, activity, note, call, email and stage change using the connection “{connection.name}”. Each Pipedrive pipeline
          becomes a pipeline here with the same stages, plus Won and Lost for closed deals.
        </p>
      )}

      {run.error ? <p className="text-sm text-destructive" role="alert">{run.error.message}</p> : null}

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{result ? "Done" : "Cancel"}</Button>
        {connections.isLoading || connections.error ? null : connection ? (
          <Button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Importing…" : result || run.error ? "Import again" : "Start import"}
          </Button>
        ) : (
          <Button asChild>
            <Link to={appSourceConnectHref("pipedrive")}>Connect Pipedrive</Link>
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
