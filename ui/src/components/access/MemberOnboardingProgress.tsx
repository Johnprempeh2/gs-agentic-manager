import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { onboardingApi } from "@/api/onboarding";
import { useOnboardingQuest } from "@/hooks/useOnboardingQuest";
import { findStepInState } from "@/lib/onboarding-quest";
import { queryKeys } from "@/lib/queryKeys";
import { QuestProgressSummary } from "@/pages/GettingStarted";

/** The owner's view of a member's Getting started: the bar, the badges and the step they are on. Read only. */
export function MemberOnboardingProgress({ companyId, memberId, name, self }: { companyId: string; memberId: string; name: string; self: boolean }) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.memberOnboarding(companyId, memberId),
    queryFn: () => onboardingApi.member(companyId, memberId),
    retry: false,
  });
  const mine = useOnboardingQuest();
  // Looking at someone else's progress is the "running the team" step for owners and admins.
  const pending = mine.state && !self ? findStepInState(mine.state, "see-member-progress") : undefined;
  useEffect(() => {
    if (data && pending && !pending.doneAt && mine.state?.startedAt && !mine.visit.isPending) mine.visit.mutate("see-member-progress");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(data), pending?.doneAt]);

  if (isError) return null;
  const next = data?.chapters.flatMap((chapter) => (chapter.skipped ? [] : chapter.steps)).find((step) => !step.doneAt);
  return (
    <section className="space-y-2 rounded-lg border border-border p-3" aria-label="Getting started progress" data-testid="member-onboarding-progress">
      <h3 className="text-sm font-semibold text-foreground">Getting started</h3>
      {data ? (
        <>
          <QuestProgressSummary state={data} who={name} />
          {data.startedAt && !data.finishedAt && next ? (
            <p className="text-sm text-muted-foreground">Next step for {name}: {next.title}.</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </section>
  );
}
