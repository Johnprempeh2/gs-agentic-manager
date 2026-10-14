import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import type { OrganisationImportCounts, OrganisationImportResult, ToolConnection } from "@greatstone/shared";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { organisationsApi } from "@/api/organisations";
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

/**
 * "Import from Pipedrive" on Organisations (GRE-1479). Owners only. Without a
 * working Pipedrive connection it points to the Apps setup; with one it runs
 * the read-only import and shows what changed.
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

function PipedriveImportDialogContent({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const connection = activePipedriveConnection(connections.data?.connections ?? []);
  const run = useMutation<OrganisationImportResult, Error>({
    mutationFn: () => organisationsApi.importFromPipedrive(companyId, connection!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) }),
  });
  const result = run.data;

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Import from Pipedrive</DialogTitle>
        <DialogDescription>
          Reads every organisation and person in Pipedrive. Nothing is written to Pipedrive, and running it again
          updates what it imported before instead of adding duplicates.
        </DialogDescription>
      </DialogHeader>

      {connections.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking for a Pipedrive connection…</p>
      ) : connections.error ? (
        <p className="text-sm text-destructive" role="alert">Could not check your connections. {connections.error.message}</p>
      ) : !connection ? (
        <p className="text-sm">
          Connect Pipedrive in Apps first, using the personal API token from Settings &gt; Personal preferences &gt; API in Pipedrive.
        </p>
      ) : run.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Importing from Pipedrive. Large accounts can take a minute.
        </p>
      ) : result ? (
        <div className="space-y-2 text-sm" role="status">
          <p className="font-medium">Import finished.</p>
          <ul className="space-y-1">
            <li>{countsText("Organisations", result.organisations)}</li>
            <li>{countsText("People", result.contacts)}</li>
          </ul>
          {result.errorSamples.length > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs text-muted-foreground" aria-label="Import errors">
              {result.errorSamples.map((sample) => (
                <li key={`${sample.kind}-${sample.externalId}`}>
                  {sample.kind === "organisation" ? "Organisation" : "Person"} {sample.externalId}: {sample.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Using the connection “{connection.name}”.</p>
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
    </DialogContent>
  );
}
