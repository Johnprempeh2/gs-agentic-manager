import type {
  IntelligenceBoardHistory,
  IntelligenceBoards,
  IntelligenceRecommendation,
  IntelligenceRecommendationStatus,
  IntelligenceReport,
  IntelligenceReportKind,
  IntelligenceReportSummary,
} from "@greatstone/shared";
import { api, ApiError } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/intelligence`;

/** Intelligence page client: reports, boards and recommendations an agent writes. */
export const intelligenceApi = {
  /** `date` is YYYY-MM-DD or `latest`. */
  report: (companyId: string, date: string, kind: IntelligenceReportKind) =>
    api.get<IntelligenceReport>(`${base(companyId)}/reports/${encodeURIComponent(date)}?kind=${kind}`),
  reports: (companyId: string) =>
    api.get<{ reports: IntelligenceReportSummary[] }>(`${base(companyId)}/reports?limit=120`),
  boards: (companyId: string, date?: string | null) =>
    api.get<IntelligenceBoards>(`${base(companyId)}/boards${date ? `?date=${encodeURIComponent(date)}` : ""}`),
  boardHistory: (companyId: string, date?: string | null) =>
    api.get<{ history: IntelligenceBoardHistory[] }>(`${base(companyId)}/boards/history${date ? `?date=${encodeURIComponent(date)}` : ""}`),
  recommendations: (companyId: string) =>
    api.get<{ recommendations: IntelligenceRecommendation[] }>(`${base(companyId)}/recommendations`),
  decide: (id: string, status: IntelligenceRecommendationStatus) =>
    api.patch<IntelligenceRecommendation>(`/intelligence/recommendations/${encodeURIComponent(id)}`, { status }),
  createTask: (id: string, projectId: string | null) =>
    api.post<IntelligenceRecommendation>(`/intelligence/recommendations/${encodeURIComponent(id)}/task`, { projectId }),
};

/** A missing report is an empty day, not an error. */
export async function reportOrNull(companyId: string, date: string, kind: IntelligenceReportKind) {
  try {
    return await intelligenceApi.report(companyId, date, kind);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
