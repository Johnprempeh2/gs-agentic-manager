import type {
  MotionStudiesResponse,
  MotionStudy,
  MotionStudyDecision,
  MotionStudyStatus,
  UpdateMotionStudy,
} from "@greatstone/shared";
import { api } from "./client";

export const motionStudiesApi = {
  list: (companyId: string, params: { status?: MotionStudyStatus; decision?: MotionStudyDecision; textSafe?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.decision) search.set("decision", params.decision);
    if (params.textSafe !== undefined) search.set("textSafe", String(params.textSafe));
    const query = search.toString();
    return api.get<MotionStudiesResponse>(`/companies/${companyId}/motion-studies${query ? `?${query}` : ""}`);
  },
  update: (id: string, body: UpdateMotionStudy) => api.patch<MotionStudy>(`/motion-studies/${id}`, body),
  resolveProposal: (id: string, accept: boolean) => api.post<MotionStudy>(`/motion-studies/${id}/proposal`, { accept }),
};
