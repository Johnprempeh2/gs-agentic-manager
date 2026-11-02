import type { LiveDesignRequest, LiveDesignView } from "@greatstone/shared";
import { api } from "./client";

const session = (id: string) => `/live-design/${encodeURIComponent(id)}`;

export const liveDesignApi = {
  start: (attachmentId: string) => api.post<LiveDesignView>(`/attachments/${encodeURIComponent(attachmentId)}/live`, {}),
  get: (id: string) => api.get<LiveDesignView>(session(id), { cache: "no-store" }),
  request: (id: string, request: LiveDesignRequest) => api.post<LiveDesignView>(`${session(id)}/request`, request),
  accept: (id: string, requestId: string, variant: number) =>
    api.post<LiveDesignView>(`${session(id)}/accept`, { requestId, variant }),
  discard: (id: string) => api.post<LiveDesignView>(`${session(id)}/discard`, {}),
  end: (id: string) => api.post<LiveDesignView>(`${session(id)}/end`, {}),
};
