import { useState } from "react";
import type { Agent } from "@greatstone/shared";
import { Check, ChevronDown, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { leadAgentId } from "@/lib/goal-journey";
import { AgentAvatar } from "../AgentAvatar";

/** Any live agent can own a goal; the lead agent is marked because new goals default to it. */
export function GoalOwnerPicker({
  agents,
  value,
  onChange,
  disabled = false,
}: {
  agents: Agent[];
  value: string | null;
  onChange: (agentId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = agents.filter((agent) => agent.status !== "terminated");
  const current = value ? agents.find((agent) => agent.id === value) : undefined;
  const leadId = leadAgentId(agents);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label="Change goal owner" className="max-w-full">
          {current ? (
            <AgentAvatar agent={current} size={16} />
          ) : (
            <User className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 truncate">Owner: {current?.name ?? "none"}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="end">
        <ul role="listbox" aria-label="Goal owner" className="max-h-72 overflow-y-auto">
          {rows.map((agent) => {
            const selected = agent.id === value;
            return (
              <li key={agent.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                    selected && "bg-accent",
                  )}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onChange(agent.id);
                  }}
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
