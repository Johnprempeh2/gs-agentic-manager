import { useState } from "react";
import { Users } from "lucide-react";
import type { Agent } from "@greatstone/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { noContactAutofill } from "@/lib/no-contact-autofill";
import type { TeamChatCandidate } from "./NewTeamChatDialog";

export interface NewMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Pick<Agent, "id" | "name" | "role" | "title" | "appearance">[];
  /** Company members you can message (team chat on); empty hides the People group. */
  people: TeamChatCandidate[];
  /** Offered when team chat is on. */
  onNewGroup?: () => void;
  onPickAgent: (agentId: string) => void;
  onPickPerson: (userId: string) => void;
}

/**
 * New message, as in every messenger: one search over agents and people, with
 * "New group" on top. Picking someone opens the chat with them (an agent chat
 * starts on the first send; a direct message reuses an existing one).
 */
export function NewMessageDialog({ open, onOpenChange, ...props }: NewMessageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="px-4 pb-3 pt-4">
          <DialogTitle>New message</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">Message an agent or a person, or start a group.</DialogDescription>
        </div>
        <NewMessageResults
          {...props}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewMessageResults({
  agents,
  people,
  onNewGroup,
  onPickAgent,
  onPickPerson,
  close,
}: Omit<NewMessageDialogProps, "open" | "onOpenChange"> & { close: () => void }) {
  const [search, setSearch] = useState("");
  const row = "min-h-11 gap-3 px-3 py-2";
  return (
    <Command>
      <CommandInput
        aria-label="Search agents and people"
        placeholder="Search agents and people"
        {...noContactAutofill("new-message")}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-96">
        <CommandEmpty>No one matches “{search}”.</CommandEmpty>
        {onNewGroup ? (
          <CommandGroup>
            <CommandItem value="new-group" keywords={["group", "new group"]} className={row} onSelect={() => { close(); onNewGroup(); }}>
              <span className="gs-convo-avatar flex size-8 items-center justify-center rounded-full"><Users aria-hidden="true" className="size-4" /></span>
              <span className="font-medium">New group</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
        {agents.length ? (
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`agent:${agent.id}`}
                keywords={[agent.name, agent.title ?? "", agent.role]}
                className={row}
                onSelect={() => { close(); onPickAgent(agent.id); }}
              >
                <span className="gs-convo-avatar flex size-8 items-center justify-center rounded-full"><AgentAvatar agent={agent} size={24} /></span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {people.length ? (
          <CommandGroup heading="People">
            {people.map((person) => (
              <CommandItem
                key={person.id}
                value={`user:${person.id}`}
                keywords={[person.name]}
                className={row}
                onSelect={() => { close(); onPickPerson(person.id); }}
              >
                <span className="gs-convo-avatar flex size-8 items-center justify-center rounded-full text-xs font-semibold">{deriveInitials(person.name)}</span>
                <span className="truncate font-medium">{person.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}
