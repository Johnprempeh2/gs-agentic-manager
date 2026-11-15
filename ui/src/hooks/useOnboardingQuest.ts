import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { onboardingApi, type QuestState } from "@/api/onboarding";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The signed-in person's Getting started quest. While it runs it is read again
 * every 20 seconds and on focus, because event steps tick on the server when the
 * person does the real thing elsewhere (a message, a comment, a status).
 */
export function useOnboardingQuest() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const key = queryKeys.onboarding(selectedCompanyId ?? "none");
  const query = useQuery({
    queryKey: key,
    queryFn: () => onboardingApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
    staleTime: 10_000,
    refetchInterval: (q) => {
      const data = q.state.data as QuestState | undefined;
      return data?.startedAt && !data.finishedAt ? 20_000 : false;
    },
  });
  const settle = { onSuccess: (data: QuestState) => queryClient.setQueryData(key, data) };
  const start = useMutation({ mutationFn: () => onboardingApi.start(selectedCompanyId!), ...settle });
  const visit = useMutation({ mutationFn: (step: string) => onboardingApi.visit(selectedCompanyId!, step), ...settle });
  const skip = useMutation({
    mutationFn: (input: { chapter: string; skipped: boolean }) => onboardingApi.skipChapter(selectedCompanyId!, input.chapter, input.skipped),
    ...settle,
  });
  const clearPractice = useMutation({ mutationFn: () => onboardingApi.clearPractice(selectedCompanyId!), ...settle });
  const replay = useMutation({ mutationFn: () => onboardingApi.replay(selectedCompanyId!), ...settle });
  return { state: query.data, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch, start, visit, skip, clearPractice, replay };
}
