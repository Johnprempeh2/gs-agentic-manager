import { useState } from "react";
import type { Agent } from "@greatstone/shared";
import { Check, ChevronDown, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { leadAgentId } from "@/lib/goal-journey";
import { AgentAvatar } from "../AgentAvatar";
import { Identity } from "../Identity";

export interface GoalOwnerPerson {
  id: string;
  label: string;
  image: string | null;
}

export type GoalOwnerChange = { ownerAgentId: string } | { ownerUserId: string };

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none";

/**
 * A goal is owned by one person or one agent. People are listed first; the
 * lead agent is marked because new goals with no owner go to it.
 */
export function GoalOwnerPicker({
  agents,
  people = [],
  ownerAgentId,
  ownerUserId = null,
  onChange,
  disabled = false,
}: {
  agents: Agent[];
  people?: GoalOwnerPerson[];
  ownerAgentId: string | null;
  ownerUserId?: string | null;
  onChange: (change: GoalOwnerChange) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = agents.filter((agent) => agent.status !== "terminated");
  const currentAgent = !ownerUserId && ownerAgentId ? agents.find((agent) => agent.id === ownerAgentId) : undefined;
  const currentPerson = ownerUserId ? people.find((person) => person.id === ownerUserId) : undefined;
  const currentName = currentPerson?.label ?? currentAgent?.name ?? (ownerUserId ? "a person" : "none");
  const leadId = leadAgentId(agents);

  const pick = (change: GoalOwnerChange, selected: boolean) => {
    setOpen(false);
    if (!selected) onChange(change);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label="Change goal owner" className="max-w-full">
          {currentAgent ? (
            <AgentAvatar agent={currentAgent} size={16} />
          ) : (
            <User className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 truncate">Owner: {currentName}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="end">
        <ul role="listbox" aria-label="Goal owner" className="max-h-80 overflow-y-auto">
          {people.length > 0 ? (
            <li role="presentation" className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase text-muted-foreground">
              People
            </li>
          ) : null}
          {people.map((person) => {
            const selected = person.id === ownerUserId;
            return (
              <li key={`user:${person.id}`} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={cn(ROW_CLASS, selected && "bg-accent")}
                  onClick={() => pick({ ownerUserId: person.id }, selected)}
                >
                  <Identity name={person.label} avatarUrl={person.image} size="sm" className="min-w-0" />
                  {selected ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
          <li role="presentation" className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase text-muted-foreground">
            Agents
          </li>
          {rows.map((agent) => {
            const selected = !ownerUserId && agent.id === ownerAgentId;
            return (
              <li key={agent.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={cn(ROW_CLASS, selected && "bg-accent")}
                  onClick={() => pick({ ownerAgentId: agent.id }, selected)}
                >
                  <AgentAvatar agent={agent} size={20} />
                  <span className="min-w-0 truncate">{agent.name}</span>
                  {agent.id === leadId ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Lead</span>
                  ) : null}
                  {selected ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
          {rows.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">No agents yet.</li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
