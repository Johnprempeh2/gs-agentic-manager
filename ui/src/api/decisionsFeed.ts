import type {
  DecisionCardAction,
  DecisionClarityRequest,
  DecisionClarityResponse,
  DecisionsFeed,
  DecisionsFeedCount,
  Issue,
  NeedsMe,
} from "@greatstone/shared";
import { api } from "./client";

/**
 * One Decisions feed (GRE-263) and "Not now" tabling (GRE-262). The sidebar
 * badge, the Decisions header and Focus all read `count` from the same build.
 */
export const decisionsFeedApi = {
  get: (companyId: string) => api.get<DecisionsFeed>(`/companies/${companyId}/decisions-feed`),
  count: (companyId: string) => api.get<DecisionsFeedCount>(`/companies/${companyId}/decisions-feed/count`),
  /** One "needs me" list and count (GRE-355): the feed plus tasks assigned to the user. */
  needsMe: (companyId: string) => api.get<NeedsMe>(`/companies/${companyId}/needs-me`),
  askClarity: (companyId: string, cardId: string, input: DecisionClarityRequest) =>
    api.post<DecisionClarityResponse>(
      `/companies/${companyId}/decisions-feed/cards/${encodeURIComponent(cardId)}/clarity`,
      input,
    ),
  table: (issueId: string, returnAt: string | null) =>
    api.post<Issue>(`/issues/${issueId}/table`, { returnAt }),
  bringBack: (issueId: string) => api.post<Issue>(`/issues/${issueId}/bring-back`, {}),
  listTabled: (companyId: string) => api.get<Issue[]>(`/companies/${companyId}/tabled-issues`),
};

/** The API client adds `/api`; card request paths already carry it. */
export function stripApiPrefix(path: string): string {
  return path.startsWith("/api/") ? path.slice(4) : path;
}

/**
 * Run a card action's requests in order. When the action takes an input, its
 * value goes into `body[input.field]` on every request (the server contract).
 */
export async function runDecisionCardAction(action: DecisionCardAction, value?: string | null): Promise<void> {
  for (const request of action.requests) {
    const body: Record<string, unknown> = { ...request.body };
    if (action.input && value != null && value !== "") body[action.input.field] = value;
    const path = stripApiPrefix(request.path);
    if (request.method === "PATCH") await api.patch(path, body);
    else await api.post(path, body);
  }
}
