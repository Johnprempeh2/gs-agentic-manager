import type {
  CreateDeepDiveInterviewRound,
  DecideDeepDiveInterviewProposal,
  DeepDiveInterviewProposal,
  DeepDiveInterviewReleaseView,
  DeepDiveInterviewProgress,
  DeepDiveInterviewRoundView,
  DraftDeepDiveInterviewSet,
  InviteDeepDiveInterviewPeople,
  OpenDeepDiveInterviewRound,
  ReleaseDeepDiveInterviewSynthesis,
  SendDeepDiveInterviewInvites,
  UpdateDeepDiveInterviewRound,
  UpdateDeepDiveInterviewSet,
} from "@greatstone/shared";
import { api } from "./client";

// Parallel Interview rounds (GRE-2611). Mirrors server/src/routes/deep-dive-interviews.ts.
// Every write returns the whole round view, so the page replaces it in one go.

export const deepDiveInterviewsQueryKeys = {
  round: (companyId: string) => ["deep-dive-interview-round", companyId] as const,
  progress: (companyId: string) => ["deep-dive-interview-round", companyId, "progress"] as const,
  proposals: (roundId: string) => ["deep-dive-interview-round", "proposals", roundId] as const,
  release: (roundId: string) => ["deep-dive-interview-round", "release", roundId] as const,
};

/** What an invite or a send answers: counts, and the progress read from the website after it. */
export interface DeepDiveInterviewInviteResult {
  invited: number;
  created: number;
  emailed: number;
  progress: DeepDiveInterviewProgress;
}

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
  // Invites and live progress (GRE-2665). Names, emails and status come live from the website.
  progress: (companyId: string) =>
    api.get<DeepDiveInterviewProgress>(`/companies/${companyId}/deep-dive/interview-round/progress`),
  open: (roundId: string, input: OpenDeepDiveInterviewRound) =>
    api.post<DeepDiveInterviewProgress>(`/deep-dive/interview-rounds/${roundId}/open`, input),
  invite: (roundId: string, input: InviteDeepDiveInterviewPeople) =>
    api.post<DeepDiveInterviewInviteResult>(`/deep-dive/interview-rounds/${roundId}/invites`, input),
  send: (roundId: string, input: SendDeepDiveInterviewInvites) =>
    api.post<{ emailed: number; skipped: number; progress: DeepDiveInterviewProgress }>(`/deep-dive/interview-rounds/${roundId}/invites/send`, input),
  // Synthesis review (GRE-2756) and release (GRE-2667). Only a person decides, releases or withdraws.
  proposals: (roundId: string) =>
    api.get<{ roundId: string; proposals: DeepDiveInterviewProposal[] }>(`/deep-dive/interview-rounds/${roundId}/synthesis/proposals`),
  decide: (proposalId: string, input: DecideDeepDiveInterviewProposal) =>
    api.post<DeepDiveInterviewProposal>(`/deep-dive/interview-proposals/${proposalId}/decision`, input),
  release: (roundId: string) => api.get<DeepDiveInterviewReleaseView>(`/deep-dive/interview-rounds/${roundId}/synthesis/release`),
  releaseSynthesis: (roundId: string, input: ReleaseDeepDiveInterviewSynthesis) =>
    api.post<DeepDiveInterviewReleaseView>(`/deep-dive/interview-rounds/${roundId}/synthesis/release`, input),
  withdrawSynthesis: (roundId: string) =>
    api.post<DeepDiveInterviewReleaseView>(`/deep-dive/interview-rounds/${roundId}/synthesis/withdraw`, {}),
};
