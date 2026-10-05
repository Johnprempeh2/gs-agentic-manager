import type {
  MemoryActivityCounts,
  MemoryActivityFeed,
  MemoryGraph,
  MemoryGraphEdgeDetail,
  MemoryGraphNodeDetail,
  MemoryGraphStatus,
  MemoryRecordStatus,
} from "@greatstone/shared";
import { api } from "./client";

/**
 * Memory graph and contribution activity read API (GRE-864, plan 8.1–8.4).
 * The server returns only what the caller may read; the UI never hides
 * records, labels or counts itself.
 */

export interface MemoryGraphFilters {
  q?: string;
  agentId?: string;
  scopeId?: string;
  status?: MemoryGraphStatus;
}

export interface MemoryActivityFilters {
  q?: string;
  agentId?: string;
  /** Contributor person (counts drill-down for board members). */
  userId?: string;
  scopeId?: string;
  status?: MemoryRecordStatus;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  cursor?: string;
}

function toQuery(params: object) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const memoryGraphApi = {
  graph: (companyId: string, filters: MemoryGraphFilters = {}) =>
    api.get<MemoryGraph>(`/companies/${companyId}/memory/graph${toQuery(filters)}`),
  node: (companyId: string, recordId: string) =>
    api.get<MemoryGraphNodeDetail>(`/companies/${companyId}/memory/graph/nodes/${encodeURIComponent(recordId)}`),
  edge: (companyId: string, edgeId: string) =>
    api.get<MemoryGraphEdgeDetail>(`/companies/${companyId}/memory/graph/edges/${encodeURIComponent(edgeId)}`),
  activity: (companyId: string, filters: MemoryActivityFilters = {}) =>
    api.get<MemoryActivityFeed>(`/companies/${companyId}/memory/activity${toQuery(filters)}`),
  activityCounts: (companyId: string, filters: Omit<MemoryActivityFilters, "agentId" | "userId" | "cursor"> = {}) =>
    api.get<MemoryActivityCounts>(`/companies/${companyId}/memory/activity/counts${toQuery(filters)}`),
};
