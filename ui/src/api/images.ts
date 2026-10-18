import type {
  CreateGeneratedImage,
  CreateGeneratedImageVariations,
  GeneratedImage,
  GeneratedImageCovers,
  GeneratedImagesResponse,
  GeneratedImageVariationsResponse,
  ImageGenerationStatus,
  UpdateGeneratedImageCover,
} from "@greatstone/shared";
import { api } from "./client";

export const imagesApi = {
  status: (companyId: string) => api.get<ImageGenerationStatus>(`/companies/${companyId}/image-generation`),
  list: (
    companyId: string,
    params: { limit?: number; offset?: number; q?: string; issueId?: string; organisationId?: string } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    if (params.q?.trim()) search.set("q", params.q.trim());
    if (params.issueId) search.set("issueId", params.issueId);
    if (params.organisationId) search.set("organisationId", params.organisationId);
    const query = search.toString();
    return api.get<GeneratedImagesResponse>(`/companies/${companyId}/generated-images${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, body: CreateGeneratedImage) =>
    api.post<GeneratedImage>(`/companies/${companyId}/generated-images`, body),
  createVariations: (companyId: string, body: CreateGeneratedImageVariations) =>
    api.post<GeneratedImageVariationsResponse>(`/companies/${companyId}/generated-images/variations`, body),
  get: (id: string) => api.get<GeneratedImage>(`/generated-images/${id}`),
  remove: (id: string) => api.delete<void>(`/generated-images/${id}`),
  covers: (companyId: string) => api.get<GeneratedImageCovers>(`/companies/${companyId}/generated-images/covers`),
  setCover: (id: string, body: UpdateGeneratedImageCover) =>
    api.patch<GeneratedImage>(`/generated-images/${id}/cover`, body),
};
