import type { DeepDiveScope } from "@greatstone/shared";
import type {
  CreateDeepDiveOffering,
  CreateDeepDivePerson,
  CreateDeepDiveProcess,
  CreateDeepDiveTask,
  CreateDeepDiveUnit,
  DeepDiveOrgBoard,
  DeepDiveProcessBoard,
  RecordDeepDiveHandoff,
  SaveDeepDiveProcessLayout,
  UpdateDeepDiveHandoff,
  UpdateDeepDiveOffering,
  UpdateDeepDivePerson,
  UpdateDeepDiveProcess,
  UpdateDeepDiveTask,
  UpdateDeepDiveUnit,
} from "@greatstone/shared";
import { api } from "./client";

// Deep Dive boards (GRE-2369). Mirrors server/src/routes/deep-dive-boards.ts.
// Every write returns the whole board, so the page replaces it in one go.

export const deepDiveBoardsQueryKeys = {
  organisation: (scope: DeepDiveScope) => ["deep-dive-boards", "organisation", scope.companyId, scope.recordCaseId] as const,
  process: (scope: DeepDiveScope) => ["deep-dive-boards", "process", scope.companyId, scope.recordCaseId] as const,
};

export const deepDiveOrgApi = {
  get: (scope: DeepDiveScope) => api.get<DeepDiveOrgBoard>(`/companies/${scope.companyId}/deep-dive/organisation?recordId=${scope.recordCaseId}`),
  addUnit: (scope: DeepDiveScope, input: CreateDeepDiveUnit) =>
    api.post<DeepDiveOrgBoard>(`/companies/${scope.companyId}/deep-dive/org-units?recordId=${scope.recordCaseId}`, input),
  updateUnit: (unitId: string, input: UpdateDeepDiveUnit) => api.patch<DeepDiveOrgBoard>(`/deep-dive/org-units/${unitId}`, input),
  removeUnit: (unitId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/org-units/${unitId}`),
  addPerson: (scope: DeepDiveScope, input: CreateDeepDivePerson) =>
    api.post<DeepDiveOrgBoard>(`/companies/${scope.companyId}/deep-dive/people?recordId=${scope.recordCaseId}`, input),
  updatePerson: (personId: string, input: UpdateDeepDivePerson) => api.patch<DeepDiveOrgBoard>(`/deep-dive/people/${personId}`, input),
  removePerson: (personId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/people/${personId}`),
  addTask: (personId: string, input: CreateDeepDiveTask) => api.post<DeepDiveOrgBoard>(`/deep-dive/people/${personId}/tasks`, input),
  updateTask: (taskId: string, input: UpdateDeepDiveTask) => api.patch<DeepDiveOrgBoard>(`/deep-dive/person-tasks/${taskId}`, input),
  removeTask: (taskId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/person-tasks/${taskId}`),
};

export const deepDiveProcessApi = {
  get: (scope: DeepDiveScope) => api.get<DeepDiveProcessBoard>(`/companies/${scope.companyId}/deep-dive/process-board?recordId=${scope.recordCaseId}`),
  saveLayout: (scope: DeepDiveScope, input: SaveDeepDiveProcessLayout) =>
    api.put<DeepDiveProcessBoard>(`/companies/${scope.companyId}/deep-dive/process-board/layout?recordId=${scope.recordCaseId}`, input),
  addOffering: (scope: DeepDiveScope, input: CreateDeepDiveOffering) =>
    api.post<DeepDiveProcessBoard>(`/companies/${scope.companyId}/deep-dive/offerings?recordId=${scope.recordCaseId}`, input),
  updateOffering: (offeringId: string, input: UpdateDeepDiveOffering) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/offerings/${offeringId}`, input),
  removeOffering: (offeringId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/offerings/${offeringId}`),
  addProcess: (scope: DeepDiveScope, input: CreateDeepDiveProcess) =>
    api.post<DeepDiveProcessBoard>(`/companies/${scope.companyId}/deep-dive/processes?recordId=${scope.recordCaseId}`, input),
  updateProcess: (processId: string, input: UpdateDeepDiveProcess) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/processes/${processId}`, input),
  removeProcess: (processId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/processes/${processId}`),
  recordHandoff: (scope: DeepDiveScope, input: RecordDeepDiveHandoff) =>
    api.post<DeepDiveProcessBoard>(`/companies/${scope.companyId}/deep-dive/handoffs?recordId=${scope.recordCaseId}`, input),
  updateHandoff: (handoffId: string, input: UpdateDeepDiveHandoff) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/handoffs/${handoffId}`, input),
  removeHandoff: (handoffId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/handoffs/${handoffId}`),
};
