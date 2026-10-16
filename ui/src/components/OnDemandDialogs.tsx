import { Suspense, useEffect, useState } from "react";
import { useLocation } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { lazyPage } from "../lib/lazy-page";
import { isOnboardingPath } from "../lib/onboarding-route";

const loadNewIssueDialog = () => import("./NewIssueDialog");
const NewIssueDialog = lazyPage(loadNewIssueDialog, "NewIssueDialog");
const NewProjectDialog = lazyPage(() => import("./NewProjectDialog"), "NewProjectDialog");
const NewGoalDialog = lazyPage(() => import("./NewGoalDialog"), "NewGoalDialog");
const NewAgentDialog = lazyPage(() => import("./NewAgentDialog"), "NewAgentDialog");
const OnboardingWizardVariant = lazyPage(
  () => import("./OnboardingWizardVariant"),
  "OnboardingWizardVariant",
);

/**
 * Mounts a dialog the first time it opens and keeps it mounted after, so its
 * code (and the editor it carries) is not part of the first download.
 */
function useOpenedOnce(open: boolean) {
  const [opened, setOpened] = useState(open);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  return opened || open;
}

/** The new task, project, goal and agent dialogs, loaded when first opened. */
export function OnDemandCreateDialogs() {
  const { newIssueOpen, newProjectOpen, newGoalOpen, newAgentOpen } = useDialog();
  const issue = useOpenedOnce(newIssueOpen);
  const project = useOpenedOnce(newProjectOpen);
  const goal = useOpenedOnce(newGoalOpen);
  const agent = useOpenedOnce(newAgentOpen);

  // New task is the one people reach for most; fetch it once the page is idle
  // so the first tap opens straight away.
  useEffect(() => {
    const prefetch = () => void loadNewIssueDialog().catch(() => {});
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetch, 3000);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <Suspense fallback={null}>
      {issue ? <NewIssueDialog /> : null}
      {project ? <NewProjectDialog /> : null}
      {goal ? <NewGoalDialog /> : null}
      {agent ? <NewAgentDialog /> : null}
    </Suspense>
  );
}

/** The onboarding wizard, loaded when opened from a button or an onboarding link. */
export function OnDemandOnboarding() {
  const { onboardingOpen } = useDialog();
  const { pathname } = useLocation();
  const show = useOpenedOnce(onboardingOpen || isOnboardingPath(pathname));
  return <Suspense fallback={null}>{show ? <OnboardingWizardVariant /> : null}</Suspense>;
}
