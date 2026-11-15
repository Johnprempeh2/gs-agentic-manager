import type { HumanCompanyMembershipRole, QuestFeatures, QuestProgress } from "@greatstone/shared";
import { api } from "./client";

export interface QuestControl {
  can: Array<{ key: string; text: string }>;
  cannot: Array<{ key: string; text: string }>;
  askFirst: Array<{ name: string; role: string }>;
}

/** Getting started, as GET /companies/:id/onboarding/me returns it. */
export interface QuestState extends QuestProgress {
  role: HumanCompanyMembershipRole;
  roleLabel: string;
  features: QuestFeatures;
  autoOpen: boolean;
  practiceIssueId: string | null;
  practiceArchived: boolean;
  control: QuestControl;
}

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/onboarding/me`;

export const onboardingApi = {
  get: (companyId: string) => api.get<QuestState>(base(companyId)),
  start: (companyId: string) => api.post<QuestState>(`${base(companyId)}/start`, {}),
  visit: (companyId: string, step: string) => api.post<QuestState>(`${base(companyId)}/visits`, { step }),
  skipChapter: (companyId: string, chapter: string, skipped: boolean) =>
    api.post<QuestState>(`${base(companyId)}/chapters`, { chapter, skipped }),
  clearPractice: (companyId: string) => api.post<QuestState>(`${base(companyId)}/practice/clear`, {}),
  replay: (companyId: string) => api.post<QuestState>(`${base(companyId)}/replay`, {}),
  member: (companyId: string, memberId: string) =>
    api.get<QuestState>(`/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(memberId)}/onboarding`),
};
