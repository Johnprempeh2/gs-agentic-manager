import type { issuesApi } from "../../api/issues";
import {
  Repeat,
  ScanEye,
  Flag,
  Check,
  Copy,
  SlidersHorizontal,
  Archive,
  FileCode2,
  MoreHorizontal,
  Plus,
  EyeOff,
} from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Link } from "@/lib/router";
import { cn } from "../../lib/utils";
import { liveBlueBadge } from "../../lib/status-colors";
import { ProjectTile } from "../../components/ProjectTile";
import { InlineEditor } from "../../components/InlineEditor";
import { workModeMetaFor } from "../../lib/work-mode-meta";
import { IssueMonitorBanner } from "../../components/IssueMonitorBanner";
import { NotNowButton } from "../../components/decisions-feed/NotNowButton";
import { TabledBanner } from "../../components/decisions-feed/TabledBanner";
import { SidePanelToggleButton } from "../../components/side-panel";
import { TaskTreeControlMenuItems } from "../../components/TaskTreeControls";
import type { MentionOption } from "../../components/MarkdownEditor";
import { PriorityIcon } from "../../components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../../lib/ui-flags";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hasAssignedBacklogBlocker } from "../../lib/issue-blockers";
import { Badge } from "@/components/ui/badge";
import type { Issue, Agent, IssueAttachment } from "@greatstone/shared";
import { IssueAttributionByline } from "./IssueAttribution";
import { useIssueMutations } from "./useIssueMutations";
import { useThreadMutations } from "./useThreadMutations";
import type { JSX, Dispatch, SetStateAction } from "react";
import type { Project } from "@greatstone/shared";
import type { CompanyUserProfile } from "@/lib/company-members";
import type { NavigateFunction } from "@/lib/router";
import type { UseMutationResult } from "@tanstack/react-query";
import type { IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";

export type IssueDetailHeaderProps = {
  streamlinedTaskDetailEnabled: boolean;
  shellSectionClass: string | undefined;
  issueStatusControl: JSX.Element;
  issue: Issue;
  updateIssue: ReturnType<typeof useIssueMutations>["updateIssue"];
  hasLiveRuns: boolean;
  taskChatShellEnabled: boolean;
  resolvedProject: Project | null;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
  userLabelMap: Map<string, string>;
  isMobile: boolean;
  isFromInbox: boolean;
  copyIssueToClipboard: () => Promise<void>;
  copied: boolean;
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  canArchiveFromInbox: boolean;
  archivePending: boolean;
  archiveFromInbox: ReturnType<typeof useThreadMutations>["archiveFromInbox"];
  isTerminalIssue: boolean;
  fileViewerEnabled: boolean;
  setFileViewerPromptOpen: Dispatch<SetStateAction<boolean>>;
  panelVisible: boolean;
  suppressPanelUntilPlan: boolean;
  openTaskSidePanel: () => void;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  openNewSubIssue: () => void;
  treeControlScope: "leaf" | "subtree";
  canPauseLeafWork: boolean;
  canShowSubtreeControls: boolean;
  activePauseHold: NonNullable<Awaited<ReturnType<typeof issuesApi.getTreeControlState>>>["activePauseHold"];
  canResumeLeafWork: boolean;
  canResumeSubtree: boolean;
  canRestoreSubtree: boolean;
  executeTreeControl: ReturnType<typeof useIssueMutations>["executeTreeControl"];
  setTreeControlMode: Dispatch<SetStateAction<"resume" | "cancel" | "restore">>;
  setTreeControlWakeAgentsOnResume: Dispatch<SetStateAction<boolean>>;
  isAgentOwnedNonTerminalIssue: boolean;
  setTreeControlOpen: Dispatch<SetStateAction<boolean>>;
  navigate: NavigateFunction;
  subTasksTree: JSX.Element | null;
  resolvedDetailTab: string;
  checkIssueMonitorNow: UseMutationResult<{ ok: true; }, Error, void, unknown>;
  mentionOptions: MentionOption[];
  externalObjectsState: IssueExternalObjectsResult;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
};

export function IssueDetailHeader({
  streamlinedTaskDetailEnabled,
  shellSectionClass,
  issueStatusControl,
  issue,
  updateIssue,
  hasLiveRuns,
  taskChatShellEnabled,
  resolvedProject,
  agentMap,
  userProfileMap,
  userLabelMap,
  isMobile,
  isFromInbox,
  copyIssueToClipboard,
  copied,
  setMobilePropsOpen,
  canArchiveFromInbox,
  archivePending,
  archiveFromInbox,
  isTerminalIssue,
  fileViewerEnabled,
  setFileViewerPromptOpen,
  panelVisible,
  suppressPanelUntilPlan,
  openTaskSidePanel,
  moreOpen,
  setMoreOpen,
  openNewSubIssue,
  treeControlScope,
  canPauseLeafWork,
  canShowSubtreeControls,
  activePauseHold,
  canResumeLeafWork,
  canResumeSubtree,
  canRestoreSubtree,
  executeTreeControl,
  setTreeControlMode,
  setTreeControlWakeAgentsOnResume,
  isAgentOwnedNonTerminalIssue,
  setTreeControlOpen,
  navigate,
  subTasksTree,
  resolvedDetailTab,
  checkIssueMonitorNow,
  mentionOptions,
  externalObjectsState,
  uploadAttachment,
}: IssueDetailHeaderProps) {
  return (
    <div
      data-testid="issue-detail-header"
      className={cn(
        streamlinedTaskDetailEnabled ? "relative space-y-2" : "space-y-3",
        shellSectionClass,
      )}
    >
      {streamlinedTaskDetailEnabled ? (
        <div className="flex min-w-0 items-start gap-2 md:items-center md:pr-8">
          <div className="hidden md:block">{issueStatusControl}</div>
          <div
            data-slot="task-detail-title"
            className="flex min-w-0 flex-1 items-baseline gap-2"
          >
            <InlineEditor
              value={issue.title}
              onSave={(title) => updateIssue.mutateAsync({ title })}
              as="h2"
              className="min-w-0 text-xl font-semibold leading-normal text-balance"
            />
            <span
              data-slot="task-title-identifier"
              className="hidden shrink-0 font-mono text-sm text-muted-foreground md:inline"
            >
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2",
          streamlinedTaskDetailEnabled && "gap-x-3 gap-y-2 md:gap-x-6 md:pl-7",
        )}
      >
        {streamlinedTaskDetailEnabled ? (
          <div className="md:hidden">{issueStatusControl}</div>
        ) : null}
        {streamlinedTaskDetailEnabled ? (
          <span className="shrink-0 font-mono text-sm text-muted-foreground md:hidden">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
        ) : null}
        {!streamlinedTaskDetailEnabled ? issueStatusControl : null}
        {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
        {SHOW_TASK_PRIORITY_UI && (
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
        )}
        {!streamlinedTaskDetailEnabled ? (
          <span className="shrink-0 font-mono text-sm text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
        ) : null}
        {hasLiveRuns && (
          <Badge
            variant="outline"
            className={cn("gap-1.5 text-(length:--text-nano)", liveBlueBadge)}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
            Live
          </Badge>
        )}

        {issue.originKind === "routine_execution" && issue.originId && (
          <Link
            to={`/routines/${issue.originId}`}
            className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-(length:--text-nano) font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            title={`Routine execution from routine ${issue.originId}`}
          >
            <Repeat className="h-3 w-3" />
            Routine
          </Link>
        )}

        {issue.originKind === "task_watchdog" ? (
          <Badge
            variant="outline"
            className="border-sky-500/40 bg-sky-500/10 text-(length:--text-nano) text-sky-700 dark:text-sky-300"
            title="This task is a generated watchdog task. It verifies whether stopped work in the watched task tree is legitimate."
          >
            <ScanEye className="h-3 w-3" />
            Watchdog
          </Badge>
        ) : null}

        {/* Task Chat Redesign: no mode chip in the header — mode is a
              per-request choice made in the composer, and each agent reply
              carries its own mode chip; a header chip would misread as a
              task-global setting. Flag OFF keeps the legacy badge. */}
        {!taskChatShellEnabled &&
        (issue.workMode === "ask" || issue.workMode === "planning")
          ? (() => {
              const workModeMeta = workModeMetaFor(issue.workMode);
              const WorkModeIcon = workModeMeta.icon;
              return (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano)",
                    workModeMeta.classes.badge,
                  )}
                  title={`This task is in ${workModeMeta.label.toLowerCase()}.`}
                >
                  <WorkModeIcon className="h-3 w-3" aria-hidden />
                  {workModeMeta.label}
                </Badge>
              );
            })()
          : null}

        {hasAssignedBacklogBlocker(issue.blockedBy) ? (
          <Badge
            variant="outline"
            data-testid="issue-detail-parked-blocker"
            className="border-amber-500/60 bg-amber-500/15 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
            title="Blocked by parked work: at least one assigned blocker is in the backlog and will not wake its assignee."
          >
            <Flag className="h-3 w-3" />
            Blocked by parked work
          </Badge>
        ) : null}

        {/* Project reads as a tile plus a name, matching the project rows in
              the sidebar and the Projects list rather than a bare outline
              glyph. The tile stays neutral here on purpose: the eyebrow already
              carries the status glyph's colour, and a second tinted swatch
              beside it competes with the one signal that means something.
              Project colour still identifies the project on project-native
              surfaces. */}
        {issue.projectId ? (
          <Link
            to={`/projects/${issue.projectId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
          >
            <ProjectTile
              size="xs"
              icon={resolvedProject?.icon ?? issue.project?.icon}
            />
            <span className="truncate">
              {resolvedProject?.name ??
                issue.project?.name ??
                issue.projectId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-subtle-foreground px-1 -mx-1 py-0.5">
            <ProjectTile size="xs" />
            No project
          </span>
        )}

        <IssueAttributionByline
          issue={issue}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          userLabelMap={userLabelMap}
        />

        {!streamlinedTaskDetailEnabled && (issue.labels ?? []).length > 0 && (
          <div className="hidden sm:flex items-center gap-1">
            {(issue.labels ?? []).slice(0, 4).map((label) => (
              <Badge
                variant="outline"
                key={label.id}
                className="text-(length:--text-nano)"
                style={{
                  borderColor: label.color,
                  color: pickTextColorForPillBg(label.color, 0.12),
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </Badge>
            ))}
            {(issue.labels ?? []).length > 4 && (
              <span className="text-(length:--text-nano) text-muted-foreground">
                +{(issue.labels ?? []).length - 4}
              </span>
            )}
          </div>
        )}

        {!streamlinedTaskDetailEnabled && !(isMobile && isFromInbox) && (
          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy task as markdown"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="hidden md:flex items-center md:ml-auto shrink-0">
          {!streamlinedTaskDetailEnabled && canArchiveFromInbox && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (!archivePending && issue?.id)
                  archiveFromInbox.mutate(issue.id);
              }}
              disabled={archivePending}
              title="Archive from inbox"
              aria-label="Archive from inbox"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {!issue.tabledAt && !isTerminalIssue ? (
            <NotNowButton
              companyId={issue.companyId}
              issueId={issue.id}
              issueLabel={issue.identifier}
            />
          ) : null}
          {fileViewerEnabled ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setFileViewerPromptOpen(true)}
              title="Open file... (g f)"
              aria-label="Open file in this issue"
            >
              <FileCode2 className="h-4 w-4" />
            </Button>
          ) : null}
          {!streamlinedTaskDetailEnabled ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy task as markdown"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          ) : null}
          {!streamlinedTaskDetailEnabled &&
          !taskChatShellEnabled &&
          (!panelVisible || suppressPanelUntilPlan) ? (
            <TooltipProvider>
              <SidePanelToggleButton
                open={false}
                onToggle={openTaskSidePanel}
                shortcut="]"
                className="shrink-0"
              />
            </TooltipProvider>
          ) : null}
          <div
            data-slot="task-title-actions"
            className={cn(
              streamlinedTaskDetailEnabled &&
                "absolute right-0 top-0 flex h-7 items-center",
            )}
          >
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="More task actions"
                  title="More task actions"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setMoreOpen(true);
                    }
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-1" align="end">
                {streamlinedTaskDetailEnabled ? (
                  <>
                    <button
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                      onClick={() => {
                        openNewSubIssue();
                        setMoreOpen(false);
                      }}
                    >
                      <Plus className="h-3 w-3" />
                      Add subtask
                    </button>
                    <button
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                      onClick={() => {
                        void copyIssueToClipboard();
                        setMoreOpen(false);
                      }}
                    >
                      {copied ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      Copy as markdown
                    </button>
                    {canArchiveFromInbox ? (
                      <button
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
                        disabled={archivePending}
                        onClick={() => {
                          if (!archivePending && issue?.id)
                            archiveFromInbox.mutate(issue.id);
                          setMoreOpen(false);
                        }}
                      >
                        <Archive className="h-3 w-3" />
                        Archive from inbox
                      </button>
                    ) : null}
                  </>
                ) : null}
                <TaskTreeControlMenuItems
                  scope={treeControlScope}
                  canPause={
                    canPauseLeafWork ||
                    (canShowSubtreeControls &&
                      !activePauseHold &&
                      !isTerminalIssue)
                  }
                  canResume={canResumeLeafWork || canResumeSubtree}
                  canCancel={canShowSubtreeControls}
                  canRestore={canRestoreSubtree}
                  pending={executeTreeControl.isPending}
                  onPause={() => {
                    executeTreeControl.mutate({
                      mode: "pause",
                      scope: treeControlScope,
                    });
                    setMoreOpen(false);
                  }}
                  onResume={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("resume");
                    setTreeControlWakeAgentsOnResume(
                      isAgentOwnedNonTerminalIssue || canShowSubtreeControls,
                    );
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                  onCancel={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("cancel");
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                  onRestore={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("restore");
                    setTreeControlWakeAgentsOnResume(false);
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                />
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                  onClick={() => {
                    updateIssue.mutate(
                      { hiddenAt: new Date().toISOString() },
                      { onSuccess: () => navigate("/issues/all") },
                    );
                    setMoreOpen(false);
                  }}
                >
                  <EyeOff className="h-3 w-3" />
                  Hide this task
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {!streamlinedTaskDetailEnabled ? (
        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className={
            taskChatShellEnabled
              ? "text-base font-semibold"
              : "text-xl font-bold"
          }
        />
      ) : null}

      {taskChatShellEnabled && !streamlinedTaskDetailEnabled
        ? subTasksTree
        : null}

      <TabledBanner issue={issue} />

      {/* On the chat tab the strip above the composer carries the monitor's
          state and Check now; the other tabs have no composer, so they keep
          this banner. */}
      {resolvedDetailTab === "chat" ? null : (
        <IssueMonitorBanner
          issue={issue}
          onCheckNow={() => checkIssueMonitorNow.mutate()}
          checkingNow={checkIssueMonitorNow.isPending}
        />
      )}

      {taskChatShellEnabled ? null : (
        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-sm leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          foldable
          mentions={mentionOptions}
          externalReferences={
            externalObjectsState.isEnabled
              ? externalObjectsState.markdownReferences
              : undefined
          }
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onDropFile={async (file) => {
            await uploadAttachment.mutateAsync(file);
          }}
        />
      )}
    </div>
  );
}
