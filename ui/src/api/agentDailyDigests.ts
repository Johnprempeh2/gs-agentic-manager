import type { AgentDailyDigest } from "@greatstone/shared";
import { api } from "./client";

export interface AgentDailyDigestList {
  from: string;
  to: string;
  /** Newest day first. */
  digests: AgentDailyDigest[];
}

/** The nightly digests of what each agent did, with spend, for a range of UTC days. */
export const agentDailyDigestsApi = {
  list: (companyId: string, range: { from: string; to: string }) =>
    api.get<AgentDailyDigestList>(
      `/companies/${companyId}/agent-daily-digests?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
    ),
};
