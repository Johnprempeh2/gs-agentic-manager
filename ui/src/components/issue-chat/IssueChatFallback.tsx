import type { ThreadMessage } from "@assistant-ui/react";
import { type ReactNode, Component, type ErrorInfo } from "react";
import type { Agent } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/InlineBanner";
import { Card } from "@/components/ui/card";
import { type MarkdownExternalReferenceMap, MarkdownBody } from "../MarkdownBody";
import { cn } from "../../lib/utils";
import { PauseCircle, AlertTriangle } from "lucide-react";
import { fallbackTextParts, fallbackAuthorLabel, commentDateLabel } from "./helpers";

type IssueChatErrorBoundaryProps = {
  resetKey: string;
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  externalReferences?: MarkdownExternalReferenceMap;
  children: ReactNode;
};

type IssueChatErrorBoundaryState = {
  hasError: boolean;
};

export class IssueChatErrorBoundary extends Component<
  IssueChatErrorBoundaryProps,
  IssueChatErrorBoundaryState
> {
  override state: IssueChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): IssueChatErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      "Issue chat renderer failed; falling back to safe transcript view",
      {
        error,
        info: info.componentStack,
      },
    );
  }

  override componentDidUpdate(prevProps: IssueChatErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <IssueChatFallbackThread
          messages={this.props.messages}
          emptyMessage={this.props.emptyMessage}
          variant={this.props.variant}
          externalReferences={this.props.externalReferences}
        />
      );
    }
    return this.props.children;
  }
}

export function IssueAssigneePausedNotice({
  agent,
  onResume,
  resuming,
}: {
  agent: Agent | null;
  onResume?: () => Promise<void> | void;
  resuming?: boolean;
}) {
  if (!agent || agent.status !== "paused") return null;

  const pauseDetail =
    agent.pauseReason === "budget"
      ? "It was paused by a budget hard stop."
      : agent.pauseReason === "import"
        ? "It arrived paused from an organisation import. Imported agents stay parked until you resume them."
        : agent.pauseReason === "system"
          ? "It was paused by the system."
          : "It was paused manually.";
  // Budget pauses clear on their own when the budget resets; resuming by hand
  // would fight the hard stop, so the action is only offered for the rest.
  const canResume = Boolean(onResume) && agent.pauseReason !== "budget";

  return (
    <div data-testid="issue-assignee-paused-notice" className="mb-3">
      <InlineBanner
        tone="warning"
        icon={PauseCircle}
        compact
        title={
          <>
            <span className="font-medium">{agent.name}</span> is paused.
          </>
        }
        actions={
          canResume ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onResume}
              disabled={resuming}
              data-testid="issue-assignee-paused-resume"
            >
              {resuming ? "Resuming…" : "Resume agent"}
            </Button>
          ) : undefined
        }
      >
        New runs will not start until the agent is resumed. {pauseDetail}
      </InlineBanner>
    </div>
  );
}

function IssueChatFallbackThread({
  messages,
  emptyMessage,
  variant,
  externalReferences,
}: {
  messages: readonly ThreadMessage[];
  emptyMessage: string;
  variant: "full" | "embedded";
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  return (
    <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
      <div className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              Chat renderer hit an internal state error.
            </p>
            <p className="text-xs">
              Showing a safe fallback transcript instead of crashing the tasks
              page.
            </p>
          </div>
        </div>
      </div>

      {messages.length === 0 ? (
        <Card
          className={cn(
            "block shadow-none text-center text-sm text-muted-foreground",
            variant === "embedded"
              ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
              : "border-dashed px-6 py-10",
          )}
        >
          {emptyMessage}
        </Card>
      ) : (
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {messages.map((message) => {
            const lines = fallbackTextParts(message);
            return (
              <Card
                key={message.id}
                className="block border-border/60 bg-card/70 px-4 py-3"
              >
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {fallbackAuthorLabel(message)}
                  </span>
                  {message.createdAt ? (
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      {commentDateLabel(message.createdAt)}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {lines.length > 0 ? (
                    lines.map((line, index) => (
                      <MarkdownBody
                        key={`${message.id}:fallback:${index}`}
                        externalReferences={externalReferences}
                      >
                        {line}
                      </MarkdownBody>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No message content.
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
