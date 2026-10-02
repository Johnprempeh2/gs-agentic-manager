import { AgentAvatar } from "@/components/AgentAvatar";
import type {
  ReasoningMessagePart,
  ToolCallMessagePart,
  ThreadMessage,
  TextMessagePart,
} from "@assistant-ui/react";
import { memo, useContext, useMemo, useState, useEffect, useRef } from "react";
import { findUIAdapter } from "../../adapters/registry";
import { useOptionalToastActions } from "../../context/ToastContext";
import { copyTextToClipboard } from "../../lib/clipboard";
import { type SegmentTiming, isCoTSegmentActive, formatDurationWords } from "../../lib/issue-chat-messages";
import { MarkdownBody } from "../MarkdownBody";
import { WorkspaceFileMarkdownBody } from "../WorkspaceFileMarkdownBody";
import { isSuccessfulRunHandoffComment, isSuccessfulRunHandoffEscalationComment } from "../../lib/successful-run-handoff";
import {
  parseToolPayload,
  formatToolPayload,
  describeToolInput,
  displayToolName,
  isCommandTool,
  summarizeToolInput,
  summarizeToolResult,
} from "../../lib/transcriptPresentation";
import { cn } from "../../lib/utils";
import {
  AlertTriangle,
  Loader2,
  ChevronDown,
  Brain,
  Check,
  Copy,
  ClipboardList,
  Hammer,
} from "lucide-react";
import {
  readCustomString,
  toTimestampOrNull,
  useLiveElapsed,
  findCoTSegmentIndex,
  toolCountSummary,
  cleanToolDisplayText,
} from "./helpers";
import { IssueChatCtx } from "./IssueChatContext";

export function IssueChatLiveRunStatusLine({
  custom,
  active,
  className,
}: {
  custom: Record<string, unknown>;
  active: boolean;
  className?: string;
}) {
  const currentStatusMessage = readCustomString(custom, "currentStatusMessage");
  const currentToolName = readCustomString(custom, "currentToolName");
  const lastAssistantSnippet = readCustomString(custom, "lastAssistantSnippet");
  const lastEventAt = readCustomString(custom, "lastEventAt");
  const lastEventAtMs = toTimestampOrNull(lastEventAt);
  const lastActivityElapsed = useLiveElapsed(lastEventAtMs, active);
  const lastActivityAgeMs = lastEventAtMs ? Date.now() - lastEventAtMs : null;

  if (!active) return null;

  const primary = currentToolName
    ? `Using ${currentToolName}`
    : lastAssistantSnippet
      ? lastAssistantSnippet
      : currentStatusMessage;
  const activityText = lastActivityElapsed
    ? lastActivityAgeMs !== null && lastActivityAgeMs >= 15_000
      ? `no output for ${lastActivityElapsed} - still running`
      : `${lastActivityElapsed} ago`
    : "";
  const text = [primary, activityText].filter(Boolean).join(" · ");
  if (!text) return null;

  return (
    <span
      className={cn(
        "mt-0.5 block truncate text-xs leading-4 text-subtle-foreground",
        className,
      )}
      title={text}
    >
      {text}
    </span>
  );
}

const IssueChatTextPart = memo(function IssueChatTextPart({
  text,
  recessed,
  onAccent,
}: {
  text: string;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  const { onImageClick, externalReferences, linkCaseReferences } =
    useContext(IssueChatCtx);
  if (isSuccessfulRunHandoffComment(text)) {
    return (
      <SuccessfulRunHandoffCommentCallout
        text={text}
        recessed={recessed}
        onImageClick={onImageClick}
      />
    );
  }
  return (
    <WorkspaceFileMarkdownBody
      className={cn(
        "text-sm leading-6",
        onAccent && "paperclip-markdown-on-accent",
      )}
      style={recessed ? { opacity: 0.55 } : undefined}
      softBreaks
      onImageClick={onImageClick}
      externalReferences={externalReferences}
      linkCaseReferences={linkCaseReferences}
    >
      {text}
    </WorkspaceFileMarkdownBody>
  );
});

export function SuccessfulRunHandoffCommentCallout({
  text,
  recessed,
  onImageClick,
}: {
  text: string;
  recessed?: boolean;
  onImageClick?: (src: string) => void;
}) {
  const escalated = isSuccessfulRunHandoffEscalationComment(text);
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 text-sm shadow-sm",
        escalated
          ? "border-red-500/35 bg-red-500/10 text-red-950 dark:text-red-100"
          : "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
      style={recessed ? { opacity: 0.55 } : undefined}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className={cn(
            "mt-1 h-4 w-4 shrink-0",
            escalated
              ? "text-red-600 dark:text-red-300"
              : "text-amber-600 dark:text-amber-300",
          )}
        />
        <MarkdownBody
          className="min-w-0 text-sm leading-6"
          softBreaks
          onImageClick={onImageClick}
        >
          {text}
        </MarkdownBody>
      </div>
    </div>
  );
}

type IssueChatCoTPart = ReasoningMessagePart | ToolCallMessagePart;

function IssueChatChainOfThought({
  message,
  cotParts,
}: {
  message: ThreadMessage;
  cotParts: readonly IssueChatCoTPart[];
}) {
  const { agentMap } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  // Adapters whose backends overwhelm the one-line reasoning ticker declare
  // a scrollable live reasoning view via their UI adapter module
  // (transcriptPresentation.liveReasoningView); resolved through the registry
  // so this component never branches on adapter identities. Every adapter
  // without a declaration keeps the existing ticker rendering.
  const adapterType =
    typeof custom.adapterType === "string" ? custom.adapterType : null;
  const isVerboseStreamingBackend =
    (adapterType
      ? findUIAdapter(adapterType)?.transcriptPresentation?.liveReasoningView
      : undefined) === "scrollLog";
  const isMessageRunning =
    message.role === "assistant" && message.status?.type === "running";

  const myIndex = useMemo(
    () => findCoTSegmentIndex(message.content, cotParts),
    [message.content, cotParts],
  );

  const allReasoningText = cotParts
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && !!p.text,
    )
    .map((p) => p.text)
    .join("\n");
  const toolParts = cotParts.filter(
    (p): p is ToolCallMessagePart => p.type === "tool-call",
  );

  const rawSegments = Array.isArray(custom.chainOfThoughtSegments)
    ? (custom.chainOfThoughtSegments as SegmentTiming[])
    : [];
  const segmentTiming = myIndex >= 0 ? (rawSegments[myIndex] ?? null) : null;
  const isActive = isCoTSegmentActive({
    isMessageRunning,
    segmentIndex: myIndex,
    segmentCount: rawSegments.length,
  });
  const [expanded, setExpanded] = useState(isActive);
  const liveElapsed = useLiveElapsed(segmentTiming?.startMs, isActive);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  let headerVerb: string;
  let headerSuffix: string | null = null;
  if (isActive) {
    headerVerb = "Working";
    if (liveElapsed) headerSuffix = `for ${liveElapsed}`;
  } else if (segmentTiming) {
    const durationMs = segmentTiming.endMs - segmentTiming.startMs;
    const durationText = formatDurationWords(durationMs);
    headerVerb = "Worked";
    if (durationText) headerSuffix = `for ${durationText}`;
  } else {
    headerVerb = "Worked";
  }

  const toolSummary = toolCountSummary(toolParts);
  const hasContent = allReasoningText.trim().length > 0 || toolParts.length > 0;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-start gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-accent/5"
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
              {agentId ? (
                <AgentAvatar agent={agentId ? agentMap?.get(agentId) ?? { id: agentId } : undefined} size={16} />
              ) : isActive ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                </span>
              )}
              {isActive ? (
                <span className="shimmer-text">{headerVerb}</span>
              ) : (
                headerVerb
              )}
            </span>
            {headerSuffix ? (
              <span className="text-xs text-subtle-foreground">
                {headerSuffix}
              </span>
            ) : null}
            {toolSummary ? (
              <span className="text-xs text-subtle-foreground">
                · {toolSummary}
              </span>
            ) : null}
          </div>
          <IssueChatLiveRunStatusLine
            custom={custom}
            active={isActive}
            className="pl-6"
          />
        </div>
        {hasContent ? (
          <ChevronDown
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-subtle-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="space-y-1 py-1">
          {isActive && isVerboseStreamingBackend ? (
            <>
              {allReasoningText ? (
                <IssueChatVerboseLiveReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.map((tool) => (
                <IssueChatToolPart
                  key={tool.toolCallId}
                  toolName={tool.toolName}
                  args={tool.args}
                  argsText={tool.argsText}
                  result={tool.result}
                  isError={false}
                />
              ))}
            </>
          ) : isActive ? (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.length > 0 ? (
                <IssueChatRollingToolPart toolParts={toolParts} />
              ) : null}
            </>
          ) : (
            <>
              {allReasoningText ? (
                <IssueChatReasoningPart text={allReasoningText} />
              ) : null}
              {toolParts.map((tool) => (
                <IssueChatToolPart
                  key={tool.toolCallId}
                  toolName={tool.toolName}
                  args={tool.args}
                  argsText={tool.argsText}
                  result={tool.result}
                  isError={false}
                />
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Live reasoning for verbose streaming backends: the one-line
// ticker cannot keep up with token-level delta volume, so show the full
// reasoning in a scrollable box that auto-follows the newest line unless the
// reader has scrolled up to review earlier thinking. All other adapters keep
// the ticker (IssueChatReasoningPart below), which is unchanged.
function IssueChatVerboseLiveReasoningPart({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinnedToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [text]);

  if (lines.length <= 1) {
    return <IssueChatReasoningPart text={text} />;
  }

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" />
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          pinnedToBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
        className="min-w-0 flex-1 max-h-40 space-y-0.5 overflow-y-auto pr-1"
      >
        {lines.map((line, index) => (
          <p
            key={index}
            className="whitespace-pre-wrap break-words text-(length:--text-compact) italic leading-5 text-subtle-foreground"
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function IssueChatReasoningPart({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] ?? text.slice(-200);
  const prevRef = useRef(lastLine);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: lastLine, exiting: null });

  useEffect(() => {
    if (lastLine !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = lastLine;
      setTicker((t) => ({ key: t.key + 1, current: lastLine, exiting: prev }));
    }
  }, [lastLine]);

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-subtle-foreground"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-subtle-foreground",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function IssueChatRollingToolPart({
  toolParts,
}: {
  toolParts: ToolCallMessagePart[];
}) {
  const latest = toolParts[toolParts.length - 1];
  if (!latest) return null;

  const fullText = cleanToolDisplayText(latest);

  const prevRef = useRef(fullText);
  const [ticker, setTicker] = useState<{
    key: number;
    current: string;
    exiting: string | null;
  }>({ key: 0, current: fullText, exiting: null });

  useEffect(() => {
    if (fullText !== prevRef.current) {
      const prev = prevRef.current;
      prevRef.current = fullText;
      setTicker((t) => ({ key: t.key + 1, current: fullText, exiting: prev }));
    }
  }, [fullText]);

  const ToolIcon = getToolIcon(latest.toolName);
  const isRunning = latest.result === undefined;

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-0.5">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-subtle-foreground" />
        ) : (
          <ToolIcon className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" />
        )}
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null && (
          <span
            key={`out-${ticker.key}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-subtle-foreground"
            onAnimationEnd={() => setTicker((t) => ({ ...t, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        )}
        <span
          key={`in-${ticker.key}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) leading-5 text-subtle-foreground",
            ticker.key > 0 && "cot-line-enter",
          )}
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function CopyablePreBlock({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  return (
    <div className="group/pre relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/pre:opacity-100",
          copied && "opacity-100",
        )}
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void copyTextToClipboard(children)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch((error) => {
              toastActions?.pushToast({
                title: "Copy failed",
                body:
                  error instanceof Error
                    ? error.message
                    : "Unable to copy text",
                tone: "error",
              });
            });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

const TOOL_ICON_MAP: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  paperclip_provider_activity: ClipboardList,
};

function getToolIcon(
  toolName: string,
): React.ComponentType<{ className?: string }> {
  return TOOL_ICON_MAP[toolName] ?? Hammer;
}

function IssueChatToolPart({
  toolName,
  args,
  argsText,
  result,
  isError,
}: {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (toolName === "paperclip_provider_activity") {
    return (
      <IssueChatProviderActivity
        args={args}
        running={result === undefined}
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />
    );
  }
  const rawArgsText = argsText ?? "";
  const parsedArgs = args ?? parseToolPayload(rawArgsText);
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : formatToolPayload(result);
  const inputDetails = describeToolInput(toolName, parsedArgs);
  const displayName = displayToolName(toolName, parsedArgs);
  const isCommand = isCommandTool(toolName, parsedArgs);
  const summary = isCommand
    ? null
    : result === undefined
      ? summarizeToolInput(toolName, parsedArgs)
      : summarizeToolResult(resultText, false);
  const ToolIcon = getToolIcon(toolName);

  const intentDetail = inputDetails.find((d) => d.label === "Intent");
  const title = intentDetail?.value ?? displayName;
  const nonIntentDetails = inputDetails.filter((d) => d.label !== "Intent");

  return (
    <div className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-1">
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" />
        {open ? <div className="mt-1 w-px flex-1 bg-border/40" /> : null}
      </div>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-accent/5"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-subtle-foreground">
            {title}
            {!intentDetail && summary ? (
              <span className="ml-1.5 text-subtle-foreground">{summary}</span>
            ) : null}
          </span>
          {result === undefined ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-subtle-foreground" />
          ) : null}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-subtle-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {open ? (
          <div className="mt-1 space-y-2 pb-1">
            {nonIntentDetails.length > 0 ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-subtle-foreground">
                  Input
                </div>
                <dl className="space-y-1.5">
                  {nonIntentDetails.map((detail) => (
                    <div key={`${detail.label}:${detail.value}`}>
                      <dt className="text-(length:--text-nano) font-medium text-subtle-foreground">
                        {detail.label}
                      </dt>
                      <dd
                        className={cn(
                          "text-xs leading-5 text-foreground/70",
                          detail.tone === "code" &&
                            "font-mono text-(length:--text-micro)",
                        )}
                      >
                        {detail.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : rawArgsText ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-subtle-foreground">
                  Input
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {rawArgsText}
                </CopyablePreBlock>
              </div>
            ) : null}
            {result !== undefined ? (
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-subtle-foreground">
                  Result
                </div>
                <CopyablePreBlock className="overflow-x-auto rounded-md bg-accent/30 p-2 text-(length:--text-micro) leading-4 text-foreground/70">
                  {resultText}
                </CopyablePreBlock>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IssueChatProviderActivity({
  args,
  running,
  open,
  onToggle,
}: {
  args: unknown;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const value =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const payload =
    typeof value.payload === "object" &&
    value.payload !== null &&
    !Array.isArray(value.payload)
      ? (value.payload as Record<string, unknown>)
      : {};
  const title =
    typeof value.title === "string" ? value.title : "Provider activity";
  const summary = typeof value.summary === "string" ? value.summary : "";
  const steps = Array.isArray(payload.steps) ? payload.steps.slice(0, 256) : [];
  const children = Array.isArray(payload.children)
    ? payload.children.slice(0, 64)
    : [];
  const sources = Array.isArray(payload.sources)
    ? payload.sources.slice(0, 64)
    : [];
  const output =
    typeof payload.output === "string" ? payload.output.slice(-(8 * 1024)) : "";
  const effectiveModel =
    typeof payload.effectiveModel === "string" ? payload.effectiveModel : null;
  const requestedModel =
    typeof payload.requestedModel === "string" ? payload.requestedModel : null;
  const hasDetails =
    steps.length > 0 ||
    children.length > 0 ||
    sources.length > 0 ||
    output.length > 0 ||
    effectiveModel !== null;
  return (
    <div
      className="flex gap-2 px-1"
      data-provider-family={String(value.family ?? "unknown")}
    >
      <div className="pt-1">
        <ClipboardList className="h-3.5 w-3.5 text-subtle-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-accent/5"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-subtle-foreground">
            {title}
            {summary ? (
              <span className="ml-1.5 text-subtle-foreground">{summary}</span>
            ) : null}
          </span>
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-subtle-foreground" />
          ) : null}
          {hasDetails ? (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-subtle-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          ) : null}
        </button>
        {open && hasDetails ? (
          <div className="mt-1 space-y-2 rounded-md border border-border/50 bg-accent/15 p-2 text-xs">
            {steps.map((entry, index) => {
              const step =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              return (
                <div key={String(step.stepId ?? index)} className="flex gap-2">
                  <span aria-hidden>
                    {step.status === "completed"
                      ? "✓"
                      : step.status === "blocked"
                        ? "!"
                        : "○"}
                  </span>
                  <span>{String(step.body ?? "")}</span>
                </div>
              );
            })}
            {children.map((entry, index) => {
              const child =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              return (
                <div key={String(child.childId ?? index)}>
                  <span className="font-medium">
                    {String(child.role ?? "Child agent")}
                  </span>{" "}
                  · {String(child.status ?? "unknown")}
                  {child.summary ? `: ${String(child.summary)}` : ""}
                </div>
              );
            })}
            {sources.map((entry, index) => {
              const source =
                typeof entry === "object" && entry !== null
                  ? (entry as Record<string, unknown>)
                  : {};
              const href =
                typeof source.url === "string" &&
                /^https?:\/\//.test(source.url)
                  ? source.url
                  : null;
              return (
                <div key={String(source.sourceId ?? index)}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {String(source.title ?? href)}
                    </a>
                  ) : (
                    <span>{String(source.title ?? "Unavailable source")}</span>
                  )}{" "}
                  <span className="text-muted-foreground">
                    (provider-reported)
                  </span>
                </div>
              );
            })}
            {effectiveModel ? (
              <div>
                <span className="text-muted-foreground">Model</span>{" "}
                {requestedModel && requestedModel !== effectiveModel
                  ? `${requestedModel} → `
                  : ""}
                {effectiveModel}
              </div>
            ) : null}
            {output ? (
              <CopyablePreBlock className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-(length:--text-micro)">
                {output}
              </CopyablePreBlock>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function getThreadMessageCopyText(message: ThreadMessage) {
  return message.content
    .filter((part): part is TextMessagePart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

export const IssueChatTextParts = memo(function IssueChatTextParts({
  message,
  recessed = false,
  onAccent = false,
}: {
  message: ThreadMessage;
  recessed?: boolean;
  onAccent?: boolean;
}) {
  return (
    <>
      {message.content
        .filter((part): part is TextMessagePart => part.type === "text")
        .map((part, index) => (
          <IssueChatTextPart
            key={`${message.id}:text:${index}`}
            text={part.text}
            recessed={recessed}
            onAccent={onAccent}
          />
        ))}
    </>
  );
});

function groupAssistantParts(
  content: readonly ThreadMessage["content"][number][],
): Array<
  | { type: "text"; part: TextMessagePart; index: number }
  | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
> {
  const groups: Array<
    | { type: "text"; part: TextMessagePart; index: number }
    | { type: "cot"; parts: IssueChatCoTPart[]; startIndex: number }
  > = [];
  let pendingCoT: IssueChatCoTPart[] = [];
  let pendingStartIndex = -1;

  const flushCoT = () => {
    if (pendingCoT.length === 0) return;
    groups.push({
      type: "cot",
      parts: pendingCoT,
      startIndex: pendingStartIndex,
    });
    pendingCoT = [];
    pendingStartIndex = -1;
  };

  content.forEach((part, index) => {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (pendingCoT.length === 0) pendingStartIndex = index;
      pendingCoT.push(part);
      return;
    }
    flushCoT();
    if (part.type === "text") {
      groups.push({ type: "text", part, index });
    }
  });
  flushCoT();

  return groups;
}

export const IssueChatAssistantParts = memo(function IssueChatAssistantParts({
  message,
  hasCoT,
}: {
  message: ThreadMessage;
  hasCoT: boolean;
}) {
  const groupedParts = useMemo(
    () => groupAssistantParts(message.content),
    [message.content],
  );
  return (
    <>
      {groupedParts.map((group) => {
        if (group.type === "text") {
          return (
            <IssueChatTextPart
              key={`${message.id}:text:${group.index}`}
              text={group.part.text}
              recessed={hasCoT}
            />
          );
        }
        return (
          <IssueChatChainOfThought
            key={`${message.id}:cot:${group.startIndex}`}
            message={message}
            cotParts={group.parts}
          />
        );
      })}
    </>
  );
});
