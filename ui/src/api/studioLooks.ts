import type { CreateStudioLook, StudioLook, StudioLooksResponse, UpdateStudioLook } from "@greatstone/shared";
import { api } from "./client";

export const studioLooksApi = {
  list: (companyId: string) => api.get<StudioLooksResponse>(`/companies/${companyId}/studio-looks`),
  create: (companyId: string, body: CreateStudioLook) => api.post<StudioLook>(`/companies/${companyId}/studio-looks`, body),
  update: (id: string, body: UpdateStudioLook) => api.patch<StudioLook>(`/studio-looks/${id}`, body),
  remove: (id: string) => api.delete<void>(`/studio-looks/${id}`),
};
