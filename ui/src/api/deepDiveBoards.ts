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
  organisation: (companyId: string) => ["deep-dive-boards", "organisation", companyId] as const,
  process: (companyId: string) => ["deep-dive-boards", "process", companyId] as const,
};

export const deepDiveOrgApi = {
  get: (companyId: string) => api.get<DeepDiveOrgBoard>(`/companies/${companyId}/deep-dive/organisation`),
  addUnit: (companyId: string, input: CreateDeepDiveUnit) =>
    api.post<DeepDiveOrgBoard>(`/companies/${companyId}/deep-dive/org-units`, input),
  updateUnit: (unitId: string, input: UpdateDeepDiveUnit) => api.patch<DeepDiveOrgBoard>(`/deep-dive/org-units/${unitId}`, input),
  removeUnit: (unitId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/org-units/${unitId}`),
  addPerson: (companyId: string, input: CreateDeepDivePerson) =>
    api.post<DeepDiveOrgBoard>(`/companies/${companyId}/deep-dive/people`, input),
  updatePerson: (personId: string, input: UpdateDeepDivePerson) => api.patch<DeepDiveOrgBoard>(`/deep-dive/people/${personId}`, input),
  removePerson: (personId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/people/${personId}`),
  addTask: (personId: string, input: CreateDeepDiveTask) => api.post<DeepDiveOrgBoard>(`/deep-dive/people/${personId}/tasks`, input),
  updateTask: (taskId: string, input: UpdateDeepDiveTask) => api.patch<DeepDiveOrgBoard>(`/deep-dive/person-tasks/${taskId}`, input),
  removeTask: (taskId: string) => api.delete<DeepDiveOrgBoard>(`/deep-dive/person-tasks/${taskId}`),
};

export const deepDiveProcessApi = {
  get: (companyId: string) => api.get<DeepDiveProcessBoard>(`/companies/${companyId}/deep-dive/process-board`),
  saveLayout: (companyId: string, input: SaveDeepDiveProcessLayout) =>
    api.put<DeepDiveProcessBoard>(`/companies/${companyId}/deep-dive/process-board/layout`, input),
  addOffering: (companyId: string, input: CreateDeepDiveOffering) =>
    api.post<DeepDiveProcessBoard>(`/companies/${companyId}/deep-dive/offerings`, input),
  updateOffering: (offeringId: string, input: UpdateDeepDiveOffering) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/offerings/${offeringId}`, input),
  removeOffering: (offeringId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/offerings/${offeringId}`),
  addProcess: (companyId: string, input: CreateDeepDiveProcess) =>
    api.post<DeepDiveProcessBoard>(`/companies/${companyId}/deep-dive/processes`, input),
  updateProcess: (processId: string, input: UpdateDeepDiveProcess) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/processes/${processId}`, input),
  removeProcess: (processId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/processes/${processId}`),
  recordHandoff: (companyId: string, input: RecordDeepDiveHandoff) =>
    api.post<DeepDiveProcessBoard>(`/companies/${companyId}/deep-dive/handoffs`, input),
  updateHandoff: (handoffId: string, input: UpdateDeepDiveHandoff) =>
    api.patch<DeepDiveProcessBoard>(`/deep-dive/handoffs/${handoffId}`, input),
  removeHandoff: (handoffId: string) => api.delete<DeepDiveProcessBoard>(`/deep-dive/handoffs/${handoffId}`),
};
