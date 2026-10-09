import type {
  MemoryReviewAgeFlag,
  MemoryReviewQueue,
  MemoryScopeSteward,
  MemoryStewardActionInput,
  MemoryStewardActionResult,
  SetMemoryScopeSteward,
} from "@greatstone/shared";
import { api } from "./client";

/**
 * Steward review queue and card actions (GRE-1080, deck v7 slides 17-20;
 * server in GRE-1089). The server decides who may act; the screen only shows
 * what it says.
 */

export interface MemoryReviewFilters {
  scopeId?: string;
  /** `user:<id>` or `agent:<id>` */
  person?: string;
  app?: string;
  age?: MemoryReviewAgeFlag;
  conflict?: "true" | "false";
}

function toQuery(filters: MemoryReviewFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const memoryReviewApi = {
  queue: (companyId: string, filters: MemoryReviewFilters = {}) =>
    api.get<MemoryReviewQueue>(`/companies/${companyId}/memory/review-queue${toQuery(filters)}`),
  act: (companyId: string, recordId: string, body: MemoryStewardActionInput) =>
    api.post<MemoryStewardActionResult>(
      `/companies/${companyId}/memory/records/${encodeURIComponent(recordId)}/steward-action`,
      body,
    ),
  stewards: (companyId: string) =>
    api.get<{ scopes: MemoryScopeSteward[] }>(`/companies/${companyId}/memory/stewards`),
  setSteward: (companyId: string, scopeId: string, body: SetMemoryScopeSteward) =>
    api.put<MemoryScopeSteward>(`/companies/${companyId}/memory/stewards/${encodeURIComponent(scopeId)}`, body),
};
