import { useEffect } from "react";
import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PrototypeList } from "@/components/prototypes/PrototypeList";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

/** Every prototype across clients (John, 14 Nov). */
export function Prototypes() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Prototypes" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Choose an organisation to view its prototypes." />;
  return (
    <div className="w-full max-w-6xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Every prototype we build, by client. New ones arrive as Internal; a client sees one in their portal only when a person turns on Visible to that client.
      </p>
      <PrototypeList companyId={selectedCompanyId} filters />
    </div>
  );
}

export default Prototypes;
