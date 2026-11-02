import type { LiveDesignHelperRequest, LiveDesignView } from "@greatstone/shared";
import { api } from "./client";

const session = (id: string) => `/live-design/${encodeURIComponent(id)}`;

export interface LiveDesignFrames {
  cursor: number;
  frames: Array<{ seq: number; data: Record<string, unknown> }>;
}

export const liveDesignApi = {
  start: (attachmentId: string) => api.post<LiveDesignView>(`/attachments/${encodeURIComponent(attachmentId)}/live`, {}),
  get: (id: string) => api.get<LiveDesignView>(session(id), { cache: "no-store" }),
  steer: (id: string, message: string) => api.post<LiveDesignView>(`${session(id)}/steer`, { message }),
  end: (id: string) => api.post<LiveDesignView>(`${session(id)}/end`, {}),
  /** Impeccable's page scripts calling their helper, which GSAM stands in for. */
  helper: (id: string, request: LiveDesignHelperRequest) =>
    api.post<{ status: number; body: string; contentType?: string }>(`${session(id)}/helper`, request),
  stream: (id: string, after: number | "start", signal?: AbortSignal) =>
    api.get<LiveDesignFrames>(`${session(id)}/stream?${after === "start" ? "start=1" : `after=${after}`}`, { cache: "no-store", signal }),
};
