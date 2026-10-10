import type {
  StartWorkflowTemplate,
  UpdateWorkflowTemplate,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTemplateStartResult,
} from "@greatstone/shared";
import { api } from "./client";

export const workflowTemplatesApi = {
  list: (companyId: string) => api.get<WorkflowTemplate[]>(`/companies/${companyId}/workflow-templates`),
  create: (
    companyId: string,
    data: { key: string; name: string; description?: string | null; definition: WorkflowTemplateDefinition },
  ) => api.post<WorkflowTemplate>(`/companies/${companyId}/workflow-templates`, data),
  update: (id: string, data: UpdateWorkflowTemplate) => api.patch<WorkflowTemplate>(`/workflow-templates/${id}`, data),
  /** Creates the coordinator issue, step issues, review stages and document slots in one go. */
  start: (id: string, data: StartWorkflowTemplate) =>
    api.post<WorkflowTemplateStartResult>(`/workflow-templates/${id}/start`, data),
};
