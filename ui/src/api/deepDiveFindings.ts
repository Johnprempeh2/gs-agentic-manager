import type { DeepDiveScope } from "@greatstone/shared";
import type { ClientEvidenceItem, DeepDiveFinding, DeepDiveVisibility, ProposeDeepDiveFinding } from "@greatstone/shared";
import { api } from "./client";

// Deep Dive findings (GRE-2367). Mirrors server/src/routes/deep-dive-findings.ts.
// A finding is never edited: there is no call that changes its statement,
// cell or evidence; a new finding supersedes it.

export const deepDiveFindingsQueryKeys = {
  list: (scope: DeepDiveScope) => ["deep-dive-findings", scope.companyId, scope.recordCaseId] as const,
  clientEvidence: (clientCaseId: string) => ["deep-dive-findings", "client-evidence", clientCaseId] as const,
};

export const deepDiveFindingsApi = {
  list: (scope: DeepDiveScope) =>
    api.get<{ findings: DeepDiveFinding[] }>(`/companies/${scope.companyId}/deep-dive/findings?recordId=${scope.recordCaseId}`).then((res) => res.findings),
  propose: (scope: DeepDiveScope, input: ProposeDeepDiveFinding) =>
    api.post<DeepDiveFinding>(`/companies/${scope.companyId}/deep-dive/findings?recordId=${scope.recordCaseId}`, input),
  decide: (findingId: string, decision: "validated" | "rejected") =>
    api.post<DeepDiveFinding>(`/deep-dive/findings/${findingId}/decision`, { decision }),
  setVisibility: (findingId: string, visibility: DeepDiveVisibility) =>
    api.patch<DeepDiveFinding>(`/deep-dive/findings/${findingId}`, { visibility }),
  /** The evidence a finding on a stream of this client may cite. */
  clientEvidence: (clientCaseId: string) =>
    api.get<{ evidence: ClientEvidenceItem[] }>(`/cases/${clientCaseId}/evidence`).then((res) => res.evidence),
};
