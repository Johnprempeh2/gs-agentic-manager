import type {
  CreateGeneratedImage,
  GeneratedImage,
  GeneratedImagesResponse,
  ImageGenerationStatus,
} from "@greatstone/shared";
import { api } from "./client";

export const imagesApi = {
  status: (companyId: string) => api.get<ImageGenerationStatus>(`/companies/${companyId}/image-generation`),
  list: (companyId: string, params: { limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    const query = search.toString();
    return api.get<GeneratedImagesResponse>(`/companies/${companyId}/generated-images${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, body: CreateGeneratedImage) =>
    api.post<GeneratedImage>(`/companies/${companyId}/generated-images`, body),
  get: (id: string) => api.get<GeneratedImage>(`/generated-images/${id}`),
  remove: (id: string) => api.delete<void>(`/generated-images/${id}`),
};
