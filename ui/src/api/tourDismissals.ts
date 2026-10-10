import { api } from "./client";

export interface TourDismissal {
  tourKey: string;
  tourVersion: number;
  seenAt: string;
}

export const tourDismissalsApi = {
  list: () => api.get<TourDismissal[]>("/tour-dismissals/me"),
  markSeen: (tourKey: string, tourVersion: number) => api.put<void>("/tour-dismissals/me", { tourKey, tourVersion }),
  reset: () => api.delete<void>("/tour-dismissals/me"),
};
