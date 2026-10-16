import type { AcceptClientEngagement, PublicClientAcceptance } from "@greatstone/shared";
import { api } from "./client";

// The client's side of online acceptance: no sign-in, the token is the key.
export const clientAcceptanceApi = {
  get: (token: string) => api.get<PublicClientAcceptance>(`/client-acceptance/${encodeURIComponent(token)}`),
  accept: (token: string, input: AcceptClientEngagement) =>
    api.post<PublicClientAcceptance>(`/client-acceptance/${encodeURIComponent(token)}/accept`, input),
};
