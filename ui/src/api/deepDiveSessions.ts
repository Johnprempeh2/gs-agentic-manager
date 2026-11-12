import type { DeepDiveScope } from "@greatstone/shared";
import type {
  AddDeepDiveSessionQuestion,
  AnswerToDeepDiveFinding,
  DeepDiveFinding,
  DeepDiveSession,
  DeepDiveSessionSummary,
  PlanDeepDiveSession,
  UpdateDeepDiveSession,
  UpdateDeepDiveSessionQuestion,
} from "@greatstone/shared";
import { api } from "./client";

// Deep Dive sessions (GRE-2368). Mirrors server/src/routes/deep-dive-sessions.ts.
// Every write returns the whole session, so the page replaces it in one go.

export const deepDiveSessionsQueryKeys = {
  list: (scope: DeepDiveScope) => ["deep-dive-sessions", scope.companyId, scope.recordCaseId] as const,
  detail: (sessionId: string) => ["deep-dive-sessions", "detail", sessionId] as const,
};

export const deepDiveSessionsApi = {
  list: (scope: DeepDiveScope) =>
    api.get<{ sessions: DeepDiveSessionSummary[] }>(`/companies/${scope.companyId}/deep-dive/sessions?recordId=${scope.recordCaseId}`).then((res) => res.sessions),
  plan: (scope: DeepDiveScope, input: PlanDeepDiveSession) =>
    api.post<DeepDiveSession>(`/companies/${scope.companyId}/deep-dive/sessions?recordId=${scope.recordCaseId}`, input),
  get: (sessionId: string) => api.get<DeepDiveSession>(`/deep-dive/sessions/${sessionId}`),
  update: (sessionId: string, input: UpdateDeepDiveSession) =>
    api.patch<DeepDiveSession>(`/deep-dive/sessions/${sessionId}`, input),
  start: (sessionId: string) => api.post<DeepDiveSession>(`/deep-dive/sessions/${sessionId}/start`, {}),
  close: (sessionId: string) => api.post<DeepDiveSession>(`/deep-dive/sessions/${sessionId}/close`, {}),
  addQuestion: (sessionId: string, input: AddDeepDiveSessionQuestion) =>
    api.post<DeepDiveSession>(`/deep-dive/sessions/${sessionId}/questions`, input),
  updateQuestion: (questionId: string, input: UpdateDeepDiveSessionQuestion) =>
    api.patch<DeepDiveSession>(`/deep-dive/session-questions/${questionId}`, input),
  removeQuestion: (questionId: string) => api.delete<DeepDiveSession>(`/deep-dive/session-questions/${questionId}`),
  answerToFinding: (questionId: string, input: AnswerToDeepDiveFinding) =>
    api.post<{ finding: DeepDiveFinding; session: DeepDiveSession }>(`/deep-dive/session-questions/${questionId}/finding`, input),
};
