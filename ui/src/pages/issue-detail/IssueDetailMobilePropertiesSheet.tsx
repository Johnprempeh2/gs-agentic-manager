import { cn } from "../../lib/utils";
import { IssueProperties, type IssuePropertiesDocumentDeepLink } from "../../components/IssueProperties";
import { TaskSidePanel } from "../../components/task-side-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Issue } from "@greatstone/shared";
import { useIssueMutations } from "./useIssueMutations";
import type { Dispatch, SetStateAction, ReactNode, JSX } from "react";
import type { IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";
import type { UseMutationResult } from "@tanstack/react-query";

export type IssueDetailMobilePropertiesSheetProps = {
  mobilePropsOpen: boolean;
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  taskChatShellEnabled: boolean;
  documentDeepLink: (IssuePropertiesDocumentDeepLink & { issueId: string; }) | null;
  issue: Issue;
  currentUserId: string | null;
  childIssues: Issue[];
  streamlinedTaskDetailEnabled: boolean;
  relationIssueLinkState: unknown;
  openNewSubIssue: () => void;
  updateIssue: ReturnType<typeof useIssueMutations>["updateIssue"];
  resolvedHasActiveRun: boolean;
  externalObjectsState: IssueExternalObjectsResult;
  checkIssueMonitorNow: UseMutationResult<{ ok: true; }, Error, void, unknown>;
  fileViewerEnabled: boolean;
  resolvedTasksTab: { count: number; content: ReactNode; hasError?: boolean; } | { count: number; hasError: boolean; content: JSX.Element; } | undefined;
  isMobile: boolean;
  artifactsOpenRequest: { issueId: string; requestId: number; handled?: boolean; } | null;
  handleArtifactsOpened: (requestId: number) => void;
  openSkill: { id: string; name: string; } | null;
  handleSkillOpened: (skillId: string) => void;
};

export function IssueDetailMobilePropertiesSheet({
  mobilePropsOpen,
  setMobilePropsOpen,
  taskChatShellEnabled,
  documentDeepLink,
  issue,
  currentUserId,
  childIssues,
  streamlinedTaskDetailEnabled,
  relationIssueLinkState,
  openNewSubIssue,
  updateIssue,
  resolvedHasActiveRun,
  externalObjectsState,
  checkIssueMonitorNow,
  fileViewerEnabled,
  resolvedTasksTab,
  isMobile,
  artifactsOpenRequest,
  handleArtifactsOpened,
  openSkill,
  handleSkillOpened,
}: IssueDetailMobilePropertiesSheetProps) {
  return (
    <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
      <SheetContent
        side={
          taskChatShellEnabled
            ? "bottom"
            : documentDeepLink?.documentKey === "plan"
              ? "right"
              : "bottom"
        }
        showCloseButton={!taskChatShellEnabled}
        className={cn(
          taskChatShellEnabled
            ? "h-(--sz-85dvh) max-h-(--sz-85dvh) w-full max-w-none gap-0 p-0 pb-(--sz-safe-bottom)"
            : documentDeepLink?.documentKey === "plan"
              ? "inset-0 h-dvh w-screen max-w-none gap-0 border-0 p-0 sm:max-w-none"
              : "max-h-(--sz-85dvh) pb-(--sz-safe-bottom)",
        )}
        data-testid={
          taskChatShellEnabled
            ? "mobile-task-side-panel"
            : documentDeepLink?.documentKey === "plan"
              ? "mobile-plan-panel"
              : undefined
        }
      >
        {taskChatShellEnabled ? (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>Task side panel</SheetTitle>
            </SheetHeader>
            <TaskSidePanel
              key={`${issue.id}:mobile`}
              issue={issue}
              accountScope={currentUserId ?? "anonymous"}
              childIssues={childIssues}
              issueLinkState={
                streamlinedTaskDetailEnabled
                  ? relationIssueLinkState
                  : undefined
              }
              onAddSubIssue={openNewSubIssue}
              onUpdate={(data) => updateIssue.mutate(data)}
              inline
              hasActiveRun={resolvedHasActiveRun}
              externalObjects={
                externalObjectsState.isEnabled
                  ? externalObjectsState.groups
                  : undefined
              }
              externalObjectsLoading={
                externalObjectsState.isEnabled
                  ? externalObjectsState.isLoading
                  : undefined
              }
              externalObjectsError={
                externalObjectsState.isEnabled
                  ? externalObjectsState.isError
                  : undefined
              }
              onRetryExternalObjects={
                externalObjectsState.isEnabled
                  ? externalObjectsState.refetch
                  : undefined
              }
              onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
              checkingMonitorNow={checkIssueMonitorNow.isPending}
              fileTabsEnabled={fileViewerEnabled}
              streamlinedTabs={streamlinedTaskDetailEnabled}
              showSubtasksTab={streamlinedTaskDetailEnabled}
              tasksTab={resolvedTasksTab}
              artifactsOpenRequestId={isMobile && !artifactsOpenRequest?.handled && artifactsOpenRequest?.issueId === issue.id
                ? artifactsOpenRequest.requestId : undefined}
              onArtifactsOpened={handleArtifactsOpened}
              openSkillId={openSkill?.id ?? null}
              openSkillName={openSkill?.name ?? null}
              onSkillOpened={handleSkillOpened}
              documentDeepLink={
                documentDeepLink?.issueId === issue.id
                  ? documentDeepLink
                  : null
              }
              onRequestClose={() => setMobilePropsOpen(false)}
            />
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="text-sm">
                {documentDeepLink?.documentKey === "plan"
                  ? "Plan"
                  : "Properties"}
              </SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1 overflow-y-auto">
              <div className="px-4 pb-4">
                <IssueProperties
                  issue={issue}
                  childIssues={childIssues}
                  issueLinkState={
                    streamlinedTaskDetailEnabled
                      ? relationIssueLinkState
                      : undefined
                  }
                  onAddSubIssue={openNewSubIssue}
                  onUpdate={(data) => updateIssue.mutate(data)}
                  inline
                  hasActiveRun={resolvedHasActiveRun}
                  externalObjects={
                    externalObjectsState.isEnabled
                      ? externalObjectsState.groups
                      : undefined
                  }
                  externalObjectsLoading={
                    externalObjectsState.isEnabled
                      ? externalObjectsState.isLoading
                      : undefined
                  }
                  externalObjectsError={
                    externalObjectsState.isEnabled
                      ? externalObjectsState.isError
                      : undefined
                  }
                  onRetryExternalObjects={
                    externalObjectsState.isEnabled
                      ? externalObjectsState.refetch
                      : undefined
                  }
                  onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
                  checkingMonitorNow={checkIssueMonitorNow.isPending}
                  documentDeepLink={
                    documentDeepLink?.issueId === issue.id
                      ? documentDeepLink
                      : null
                  }
                />
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
