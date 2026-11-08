import { LIVE_DEPLOY_REQUEST, type LiveDesignHelperRequest, type LiveDesignView } from "@greatstone/shared";
import { api } from "./client";

const session = (id: string) => `/live-design/${encodeURIComponent(id)}`;

export interface LiveDesignFrames {
  cursor: number;
  /** The session has ended: stop streaming. */
  ended?: boolean;
  frames: Array<{ seq: number; data: Record<string, unknown> }>;
}

export const liveDesignApi = {
  start: (attachmentId: string, deliverableId?: string | null) =>
    api.post<LiveDesignView>(`/attachments/${encodeURIComponent(attachmentId)}/live`, deliverableId ? { deliverableId } : {}),
  restore: (id: string, attachmentId: string) => api.post<LiveDesignView>(`${session(id)}/restore`, { attachmentId }),
  get: (id: string) => api.get<LiveDesignView>(session(id), { cache: "no-store" }),
  steer: (id: string, message: string) => api.post<LiveDesignView>(`${session(id)}/steer`, { message }),
  /** Only the Deploy button sends this; a typed message never deploys. */
  deploy: (id: string) => api.post<LiveDesignView>(`${session(id)}/steer`, { message: LIVE_DEPLOY_REQUEST, deploy: true }),
  end: (id: string) => api.post<LiveDesignView>(`${session(id)}/end`, {}),
  /** Impeccable's page scripts calling their helper, which GSAM stands in for. */
  helper: (id: string, request: LiveDesignHelperRequest) =>
    api.post<{ status: number; body: string; contentType?: string }>(`${session(id)}/helper`, request),
  stream: (id: string, after: number | "start", signal?: AbortSignal) =>
    api.get<LiveDesignFrames>(`${session(id)}/stream?${after === "start" ? "start=1" : `after=${after}`}`, { cache: "no-store", signal }),
};
