import { useEffect, useRef, useState } from "react";
import { FeatureTour } from "@/components/FeatureTour";
import { useToastActions } from "@/context/ToastContext";
import { useOnboardingQuest } from "@/hooks/useOnboardingQuest";
import { useTourSeen } from "@/hooks/useTourSeen";
import { toCompanyRelativePath } from "@/lib/company-routes";
import { findStepInState, pendingVisit, questChanges, questHintTour } from "@/lib/onboarding-quest";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { WELCOME_TOUR } from "@/lib/welcome-tour";
import type { QuestState } from "@/api/onboarding";

/**
 * Getting started, across the whole app: opens the quest once for a new member,
 * ticks visit steps when their page opens, runs a step's spotlight when "Show me"
 * asks for it (?tour=questhint-<step>, on the existing tour engine), and says
 * when a step, a chapter or the whole quest is done.
 */
export function OnboardingQuestHost() {
  const { state, start, visit, refetch } = useOnboardingQuest();
  const { pathname, search } = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { isSeen } = useTourSeen();
  const path = toCompanyRelativePath(pathname) + search;
  const opening = useRef(false);

  // A new member: wait for the welcome tour on Home, then open the quest.
  const welcomeSeen = isSeen(WELCOME_TOUR);
  useEffect(() => {
    if (!state?.autoOpen || opening.current) return;
    const onHome = /^\/dashboard\/?$/.test(toCompanyRelativePath(pathname));
    if (onHome && welcomeSeen !== true) return;
    opening.current = true;
    start.mutate(undefined, { onSuccess: () => navigate("/getting-started") });
  }, [state?.autoOpen, pathname, welcomeSeen, start, navigate]);

  // Visit steps: the page opening is the real thing.
  const sent = useRef(new Set<string>());
  useEffect(() => {
    const step = pendingVisit(path, state);
    if (!step || sent.current.has(step)) return;
    sent.current.add(step);
    visit.mutate(step, { onError: () => sent.current.delete(step) });
  }, [path, state, visit]);

  // Event steps tick on the server: read again when the person moves on.
  const started = Boolean(state?.startedAt && !state.finishedAt);
  useEffect(() => {
    if (started) void refetch();
  }, [pathname, started, refetch]);

  const previous = useRef<QuestState | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const changes = questChanges(previous.current, state);
    previous.current = state;
    for (const title of changes.steps) pushToast({ title: "Step done", body: title, tone: "success", dedupeKey: `quest-step-${title}` });
    for (const title of changes.chapters) {
      pushToast({ title: `Chapter complete: ${title}`, body: "You earned its badge.", tone: "success", ttlMs: 6000 });
    }
    if (changes.finished) {
      pushToast({ title: "Getting started complete", body: "Well done. Your practice items are archived.", tone: "success", ttlMs: 8000 });
    }
  }, [state, pushToast]);

  // The tour engine drops ?tour= once it starts, so keep the asked-for step while the
  // person stays on that page; it ends when they close the card or move on.
  const asked = searchParams.get("tour")?.match(/^questhint-([a-z0-9-]+)$/)?.[1];
  const [hint, setHint] = useState<{ key: string; pathname: string } | null>(null);
  useEffect(() => {
    if (asked) setHint({ key: asked, pathname });
  }, [asked, pathname]);
  const step = hint && hint.pathname === pathname && state ? findStepInState(state, hint.key) : undefined;
  return step
    ? <FeatureTour key={step.key} tour={questHintTour(step)} className="hidden" onClose={() => setHint(null)} />
    : null;
}
