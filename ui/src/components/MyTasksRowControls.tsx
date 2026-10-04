import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Issue } from "@greatstone/shared";
import { MessageCircleQuestion, UserRoundPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";
import { MY_TASKS_ASK_STATE_LABELS, type MyTasksAskState } from "../lib/myTasks";
import { AgentIdentity } from "./AgentIdentity";

/**
 * My tasks row controls (GRE-619): tick to finish, hand to an agent, ask.
 * The page owns the mutations; these only collect input.
 */

type HandOffAgent = { id: string; name: string } & Parameters<typeof AgentIdentity>[0]["agent"];

function issueLabel(issue: Pick<Issue, "identifier" | "title">) {
  return issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
}

export function MyTasksTickBox({
  issue,
  disabled,
  onCheckedChange,
}: {
  issue: Pick<Issue, "id" | "status" | "identifier" | "title">;
  disabled?: boolean;
  onCheckedChange: (done: boolean) => void;
}) {
  const done = issue.status === "done";
  return (
    // A 16px box gets a 24px hit area without moving the row.
    <span className="inline-flex size-6 shrink-0 items-center justify-center">
      <Checkbox
        data-my-tasks-tick={issue.id}
        checked={done}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={done ? `Reopen ${issueLabel(issue)}` : `Mark ${issueLabel(issue)} done`}
      />
    </span>
  );
}

export function MyTasksAskStateBadge({ state }: { state: MyTasksAskState }) {
  return (
    <Badge
      variant="outline"
      data-ask-state={state}
      className={cn(
        "px-1.5 text-(length:--text-nano)",
        state === "answered"
          ? "border-primary/40 bg-primary/10 text-primary"
          : "text-muted-foreground",
      )}
    >
      {MY_TASKS_ASK_STATE_LABELS[state]}
    </Badge>
  );
}

export function MyTasksHandOff<T extends HandOffAgent>({
  issue,
  agents,
  leadAgentId,
  pending,
  onHandOff,
}: {
  issue: Pick<Issue, "identifier" | "title" | "assigneeAgentId">;
  /** Active agents, lead first (see handOffAgentChoices). */
  agents: readonly T[];
  leadAgentId: string | null;
  pending?: boolean;
  onHandOff: (agent: T, instruction: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const listId = useId();
  const selected = agents.find((agent) => agent.id === agentId) ?? null;

  const reset = () => {
    setAgentId(leadAgentId ?? agents[0]?.id ?? null);
    setInstruction("");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    onHandOff(selected, instruction.trim());
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pending || agents.length === 0}
          aria-label={`Hand ${issueLabel(issue)} to an agent`}
          className="text-muted-foreground hover:text-foreground"
        >
          <UserRoundPlus aria-hidden />
          Hand to agent
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <form onSubmit={submit} className="flex flex-col">
          <p id={`${listId}-label`} className="px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
            Hand to
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${listId}-label`}
            className="max-h-56 overflow-y-auto overscroll-contain px-1"
          >
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={agent.id === agentId}
                onClick={() => setAgentId(agent.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
                  agent.id === agentId && "bg-accent",
                )}
              >
                <AgentIdentity agent={agent} size="sm" className="min-w-0 flex-1" />
                {agent.id === issue.assigneeAgentId ? (
                  <span className="shrink-0 text-xs text-muted-foreground">On it now</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t border-border p-3">
            <Input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Instruction (optional)"
              aria-label="Instruction for the agent (optional)"
              maxLength={500}
            />
            <Button type="submit" size="sm" disabled={!selected || pending}>
              {selected ? `Hand to ${selected.name}` : "Pick an agent"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function MyTasksAskButton({
  issue,
  expanded,
  controlsId,
  onToggle,
}: {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-my-tasks-ask={issue.id}
      aria-expanded={expanded}
      aria-controls={expanded ? controlsId : undefined}
      aria-label={`Ask about ${issueLabel(issue)}`}
      onClick={onToggle}
      className={cn("text-muted-foreground hover:text-foreground", expanded && "bg-accent text-foreground")}
    >
      <MessageCircleQuestion aria-hidden />
      Ask
    </Button>
  );
}

/** Inline question box under the row. Escape closes it and focus goes back to Ask. */
export function MyTasksAskBox({
  id,
  targetName,
  pending,
  onSubmit,
  onCancel,
}: {
  id: string;
  /** The agent the question wakes; null when no agent can answer. */
  targetName: string | null;
  pending?: boolean;
  onSubmit: (question: string) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || !targetName) return;
    onSubmit(text);
  };

  return (
    <form
      id={id}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="flex flex-wrap items-center gap-2 pb-2 pl-10 pr-2 sm:flex-nowrap sm:pl-14"
    >
      <Input
        ref={inputRef}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder={targetName ? `Ask ${targetName} a question` : "No agent can answer this task"}
        aria-label={targetName ? `Question for ${targetName}` : "Question"}
        disabled={!targetName || pending}
        className="h-8 min-w-0 flex-1 basis-full sm:basis-auto"
      />
      <Button type="submit" size="xs" disabled={!targetName || !question.trim() || pending}>
        Send
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
