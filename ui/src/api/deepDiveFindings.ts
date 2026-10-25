import type { ClientEvidenceItem, DeepDiveFinding, DeepDiveVisibility, ProposeDeepDiveFinding } from "@greatstone/shared";
import { api } from "./client";

// Deep Dive findings (GRE-2367). Mirrors server/src/routes/deep-dive-findings.ts.
// A finding is never edited: there is no call that changes its statement,
// cell or evidence; a new finding supersedes it.

export const deepDiveFindingsQueryKeys = {
  list: (companyId: string) => ["deep-dive-findings", companyId] as const,
  clientEvidence: (clientCaseId: string) => ["deep-dive-findings", "client-evidence", clientCaseId] as const,
};

export const deepDiveFindingsApi = {
  list: (companyId: string) =>
    api.get<{ findings: DeepDiveFinding[] }>(`/companies/${companyId}/deep-dive/findings`).then((res) => res.findings),
  propose: (companyId: string, input: ProposeDeepDiveFinding) =>
    api.post<DeepDiveFinding>(`/companies/${companyId}/deep-dive/findings`, input),
  decide: (findingId: string, decision: "validated" | "rejected") =>
    api.post<DeepDiveFinding>(`/deep-dive/findings/${findingId}/decision`, { decision }),
  setVisibility: (findingId: string, visibility: DeepDiveVisibility) =>
    api.patch<DeepDiveFinding>(`/deep-dive/findings/${findingId}`, { visibility }),
  /** The evidence a finding on a stream of this client may cite. */
  clientEvidence: (clientCaseId: string) =>
    api.get<{ evidence: ClientEvidenceItem[] }>(`/cases/${clientCaseId}/evidence`).then((res) => res.evidence),
};
