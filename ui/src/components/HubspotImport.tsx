import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import type { ImportHubspotExport } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { organisationsApi } from "@/api/organisations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys } from "@/lib/queryKeys";
import { ExportFileImport, canRunPipedriveImport, type CrmExportSpec } from "./PipedriveImport";

export const HUBSPOT_EXPORT: CrmExportSpec = {
  idPrefix: "hubspot-export",
  instructions:
    "In HubSpot, open Companies, Contacts or Deals, choose Export, and pick CSV. Add the files you have; you can add the rest later.",
  files: [
    { kind: "companies", label: "Companies", hint: "Becomes your organisations list. Customers are marked as clients." },
    { kind: "contacts", label: "Contacts", hint: "Added to their associated company." },
    { kind: "deals", label: "Deals", hint: "Open deals become client cases; closed won deals mark the company as a client." },
  ],
  dealsKind: "deals",
  submit: (companyId, body) => organisationsApi.importFromHubspotExport(companyId, body as ImportHubspotExport),
};

/**
 * "Import from HubSpot" on Organisations. Owners only. Works from the CSV
 * files HubSpot exports, so no HubSpot key is needed and nothing is written
 * to HubSpot. A rerun updates what it imported before.
 */
export function HubspotImport({ companyId }: { companyId: string }) {
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
        Import from HubSpot
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Import from HubSpot</DialogTitle>
              <DialogDescription>
                Brings your HubSpot companies, contacts and deals into GSAM. Nothing is written to HubSpot, and running it
                again updates what it imported before instead of adding duplicates.
              </DialogDescription>
            </DialogHeader>
            <ExportFileImport companyId={companyId} onClose={() => setOpen(false)} spec={HUBSPOT_EXPORT} />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
