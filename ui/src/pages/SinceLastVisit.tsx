import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Link } from "@/lib/router";
import { agentWorkDigestApi } from "../api/agentWorkDigest";
import { DigestAgentSection, digestCountsSentence, digestSinceLabel } from "../components/AgentWorkDigest";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * "Since you were last here" (GRE-357): agent work since the last visit,
 * grouped by agent, each line linking to its task. Built on the digest
 * endpoint, so housekeeping and raw audit rows stay out.
 */
export function SinceLastVisit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Since you were last here" }]);
  }, [setBreadcrumbs]);

  // Pinned for this visit: once the visit is recorded below, a refetch would
  // start from now and empty the page while the user reads it.
  const { data: digest, isLoading, error, refetch } = useQuery({
    queryKey: [...queryKeys.agentWorkDigest(selectedCompanyId!), "page"] as const,
    queryFn: () => agentWorkDigestApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const { mutate: recordVisit } = useMutation({
    mutationFn: (companyId: string) => agentWorkDigestApi.recordVisit(companyId),
    onSuccess: (_visit, companyId) => {
      // The home card now starts from this visit.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkDigest(companyId), exact: true });
    },
  });
  const recordedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!digest || recordedForRef.current === digest.companyId) return;
    recordedForRef.current = digest.companyId;
    recordVisit(digest.companyId);
  }, [digest, recordVisit]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select an organization to see agent work." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;
  if (error && !digest) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!digest) return null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Since you were last here</h1>
        <p className="text-sm text-muted-foreground">
          {digestSinceLabel(digest)}: {digestCountsSentence(digest.counts).toLowerCase()}.
        </p>
      </header>

      {digest.agents.length === 0 ? (
        <EmptyState icon={History} message="No new agent work since your last visit." />
      ) : (
        <div className="space-y-6">
          {digest.agents.map((agent) => (
            <DigestAgentSection key={agent.agentId} agent={agent} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Need every event?{" "}
        <Link to="/activity" className="underline underline-offset-2">
          Open the full Audit log
        </Link>
        .
      </p>
    </div>
  );
}
