import type {
  CreateGeneratedVideo,
  GeneratedVideo,
  GeneratedVideosResponse,
  UpdateGeneratedVideoFavourite,
  VideoGenerationStatus,
} from "@greatstone/shared";
import { api } from "./client";

export const videosApi = {
  status: (companyId: string) => api.get<VideoGenerationStatus>(`/companies/${companyId}/video-generation`),
  list: (companyId: string, params: { limit?: number; q?: string; favourite?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.q?.trim()) search.set("q", params.q.trim());
    if (params.favourite !== undefined) search.set("favourite", String(params.favourite));
    const query = search.toString();
    return api.get<GeneratedVideosResponse>(`/companies/${companyId}/generated-videos${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, body: CreateGeneratedVideo) => api.post<GeneratedVideo>(`/companies/${companyId}/generated-videos`, body),
  get: (id: string) => api.get<GeneratedVideo>(`/generated-videos/${id}`),
  remove: (id: string) => api.delete<void>(`/generated-videos/${id}`),
  setFavourite: (id: string, body: UpdateGeneratedVideoFavourite) =>
    api.patch<GeneratedVideo>(`/generated-videos/${id}/favourite`, body),
};
