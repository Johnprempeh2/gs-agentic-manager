import { Repeat } from "lucide-react";
import { readIssueDetailHeaderSeed } from "../../lib/issueDetailBreadcrumb";
import { cn } from "../../lib/utils";
import { ProjectTile } from "../../components/ProjectTile";
import { useClassicTaskInterfaceEnabled } from "../../hooks/useClassicTaskInterfaceEnabled";
import { useStreamlinedUiEnabled } from "../../hooks/useStreamlinedUiEnabled";
import { StatusIcon } from "../../components/StatusIcon";
import { PriorityIcon } from "../../components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../../lib/ui-flags";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export function IssueSectionSkeleton({
  titleWidth = "w-28",
  rows = 3,
}: {
  titleWidth?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <Skeleton className={cn("h-4", titleWidth)} />
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

/**
 * One chat-bubble placeholder mirroring TaskChatBubble's anatomy: agent replies
 * sit left under an avatar + name author row, human messages sit right with no
 * header. The bubble reuses the real rounding (rounded-2xl with a squared tail
 * corner) so the skeleton reads as a conversation, not a stack of cards.
 */
function ChatBubbleSkeleton({
  side,
  className,
}: {
  side: "agent" | "human";
  className?: string;
}) {
  const isHuman = side === "human";
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        isHuman ? "items-end" : "items-start",
      )}
    >
      {isHuman ? null : (
        <span className="flex items-center gap-2 px-1">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-3 w-24" />
        </span>
      )}
      <Skeleton
        className={cn(
          "max-w-(--pct-85)",
          isHuman ? "rounded-2xl rounded-br-sm" : "rounded-2xl rounded-bl-sm",
          className,
        )}
      />
    </div>
  );
}

/**
 * Composer placeholder mirroring TaskChatComposer's docked card (a bordered
 * rounded input area with a plus, a mode chip, and a send affordance) so the
 * foot of the loading state matches the real chat shell.
 */
function IssueChatComposerSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("rounded-xl border border-input bg-card p-2", className)}
      data-testid="issue-chat-composer-skeleton"
    >
      <div className="min-h-(--sz-48px) space-y-2 px-1 py-1">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </div>
  );
}

/**
 * Alternating chat-bubble placeholders for the thread body. Widths and heights
 * vary so the skeleton mirrors a real back-and-forth (TaskChatThreadView)
 * rather than the pre-chat bordered card it replaced.
 */
export function IssueChatSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="issue-chat-skeleton">
      <ChatBubbleSkeleton side="agent" className="h-16 w-3/4" />
      <ChatBubbleSkeleton side="human" className="h-9 w-1/2" />
      <ChatBubbleSkeleton side="agent" className="h-24 w-4/5" />
      <ChatBubbleSkeleton side="human" className="h-8 w-2/5" />
    </div>
  );
}

export function useTaskDetailInterfaceMode(conversationMode = false) {
  const {
    enabled: classicTaskInterfacePreferenceEnabled,
    loaded: classicTaskInterfaceLoaded,
  } = useClassicTaskInterfaceEnabled();
  const { enabled: streamlinedUiEnabled, loaded: streamlinedUiLoaded } =
    useStreamlinedUiEnabled();
  const classicTaskInterfaceEnabled = classicTaskInterfacePreferenceEnabled && !conversationMode;
  const taskChatShellEnabled = !classicTaskInterfaceEnabled;

  return {
    classicTaskInterfaceEnabled,
    taskChatShellEnabled,
    streamlinedTaskDetailEnabled: streamlinedUiEnabled && taskChatShellEnabled,
    streamlinedUiEnabled,
    loaded: classicTaskInterfaceLoaded && streamlinedUiLoaded,
  };
}

export function IssueDetailLoadingState({
  headerSeed,
}: {
  headerSeed: ReturnType<typeof readIssueDetailHeaderSeed>;
}) {
  const identifier =
    headerSeed?.identifier ?? headerSeed?.id.slice(0, 8) ?? null;
  const { taskChatShellEnabled } = useTaskDetailInterfaceMode();

  return (
    <div
      className={
        taskChatShellEnabled
          ? "task-chat-loading-shell mx-auto flex min-h-0 w-full max-w-(--tc-shell-max-w) flex-1 flex-col gap-6"
          : "max-w-3xl space-y-6"
      }
    >
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />

        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {headerSeed ? (
            <>
              <StatusIcon
                status={headerSeed.status}
                blockerAttention={headerSeed.blockerAttention}
              />
              {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
              {SHOW_TASK_PRIORITY_UI && (
                <PriorityIcon priority={headerSeed.priority} />
              )}
              {identifier ? (
                <span className="text-sm font-mono text-muted-foreground shrink-0">
                  {identifier}
                </span>
              ) : null}
              {headerSeed.originKind === "routine_execution" &&
              headerSeed.originId ? (
                <Badge
                  variant="outline"
                  className="border-violet-500/30 bg-violet-500/10 text-(length:--text-nano) text-violet-600 dark:text-violet-400"
                  title={`Routine execution from routine ${headerSeed.originId}`}
                >
                  <Repeat className="h-3 w-3" />
                  Routine
                </Badge>
              ) : null}
              {/* Seeded header — same anatomy as the resolved one below, so the
                  eyebrow does not change shape when the real issue arrives. */}
              {headerSeed.projectId ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground rounded px-1 -mx-1 py-0.5 min-w-0">
                  <ProjectTile size="xs" />
                  <span className="truncate">
                    {headerSeed.projectName ?? headerSeed.projectId.slice(0, 8)}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-subtle-foreground px-1 -mx-1 py-0.5">
                  <ProjectTile size="xs" />
                  No project
                </span>
              )}
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-6 w-6" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </>
          )}
        </div>

        {headerSeed ? (
          <>
            <h2 className="text-xl font-bold leading-tight">
              {headerSeed.title}
            </h2>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full max-w-xl" />
              <Skeleton className="h-4 w-(--pct-72)" />
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-8 w-(--sz-calc-37)" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>

      {taskChatShellEnabled ? (
        // Chat shell: the thread is the whole surface — alternating bubble
        // placeholders followed by the docked composer, no tab strip or
        // properties-card chrome (those don't exist in the chat layout).
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-hidden">
          <IssueChatSkeleton />
          <IssueChatComposerSkeleton />
        </div>
      ) : (
        <>
          <Skeleton className="h-28 w-full rounded-lg border border-border" />

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-20" />
            </div>
            <IssueChatSkeleton />
          </div>

          <IssueSectionSkeleton titleWidth="w-24" rows={3} />
        </>
      )}
    </div>
  );
}
