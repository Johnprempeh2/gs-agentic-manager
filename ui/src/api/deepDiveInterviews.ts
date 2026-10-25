import type {
  CreateDeepDiveInterviewRound,
  DeepDiveInterviewRoundView,
  DraftDeepDiveInterviewSet,
  UpdateDeepDiveInterviewRound,
  UpdateDeepDiveInterviewSet,
} from "@greatstone/shared";
import { api } from "./client";

// Parallel Interview rounds (GRE-2611). Mirrors server/src/routes/deep-dive-interviews.ts.
// Every write returns the whole round view, so the page replaces it in one go.

export const deepDiveInterviewsQueryKeys = {
  round: (companyId: string) => ["deep-dive-interview-round", companyId] as const,
};

export const deepDiveInterviewsApi = {
  get: (companyId: string) => api.get<DeepDiveInterviewRoundView>(`/companies/${companyId}/deep-dive/interview-round`),
  create: (companyId: string, input: CreateDeepDiveInterviewRound) =>
    api.post<DeepDiveInterviewRoundView>(`/companies/${companyId}/deep-dive/interview-round`, input),
  update: (roundId: string, input: UpdateDeepDiveInterviewRound) =>
    api.patch<DeepDiveInterviewRoundView>(`/deep-dive/interview-rounds/${roundId}`, input),
  draftSet: (roundId: string, input: DraftDeepDiveInterviewSet) =>
    api.post<DeepDiveInterviewRoundView>(`/deep-dive/interview-rounds/${roundId}/sets`, input),
  updateSet: (setId: string, input: UpdateDeepDiveInterviewSet) =>
    api.patch<DeepDiveInterviewRoundView>(`/deep-dive/interview-sets/${setId}`, input),
  redraftSet: (setId: string) => api.post<DeepDiveInterviewRoundView>(`/deep-dive/interview-sets/${setId}/redraft`, {}),
  approveSet: (setId: string) => api.post<DeepDiveInterviewRoundView>(`/deep-dive/interview-sets/${setId}/approve`, {}),
  removeSet: (setId: string) => api.delete<DeepDiveInterviewRoundView>(`/deep-dive/interview-sets/${setId}`),
};
