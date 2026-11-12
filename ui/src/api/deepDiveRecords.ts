import type {
  DecideDeepDiveDraft,
  DeepDiveDraft,
  DeepDiveDraftStatus,
  DeepDiveRecordSummary,
  DeepDiveScope,
  DeepDiveStartableClient,
} from "@greatstone/shared";
import { api } from "./client";

// One Deep Dive per client engagement and its agent drafts (GRE-4430).
// Mirrors server/src/routes/deep-dive-drafts.ts.

export const deepDiveRecordsQueryKeys = {
  list: (companyId: string) => ["deep-dive-records", companyId] as const,
  drafts: (scope: DeepDiveScope) => ["deep-dive-drafts", scope.companyId, scope.recordCaseId] as const,
};

const q = (scope: DeepDiveScope) => `recordId=${scope.recordCaseId}`;

export const deepDiveRecordsApi = {
  list: (companyId: string) =>
    api.get<{ deepDives: DeepDiveRecordSummary[]; clients: DeepDiveStartableClient[] }>(`/companies/${companyId}/deep-dives`),
  drafts: (scope: DeepDiveScope, status?: DeepDiveDraftStatus) =>
    api
      .get<{ drafts: DeepDiveDraft[] }>(`/companies/${scope.companyId}/deep-dive/drafts?${q(scope)}${status ? `&status=${status}` : ""}`)
      .then((res) => res.drafts),
  decide: (scope: DeepDiveScope, draftId: string, input: DecideDeepDiveDraft) =>
    api.post<DeepDiveDraft>(`/companies/${scope.companyId}/deep-dive/drafts/${draftId}/decision?${q(scope)}`, input),
};
