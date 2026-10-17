import type { CreateGeneratedVideo, GeneratedVideo, GeneratedVideosResponse, VideoGenerationStatus } from "@greatstone/shared";
import { api } from "./client";

export const videosApi = {
  status: (companyId: string) => api.get<VideoGenerationStatus>(`/companies/${companyId}/video-generation`),
  list: (companyId: string, params: { limit?: number; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.q?.trim()) search.set("q", params.q.trim());
    const query = search.toString();
    return api.get<GeneratedVideosResponse>(`/companies/${companyId}/generated-videos${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, body: CreateGeneratedVideo) => api.post<GeneratedVideo>(`/companies/${companyId}/generated-videos`, body),
  get: (id: string) => api.get<GeneratedVideo>(`/generated-videos/${id}`),
  remove: (id: string) => api.delete<void>(`/generated-videos/${id}`),
};
