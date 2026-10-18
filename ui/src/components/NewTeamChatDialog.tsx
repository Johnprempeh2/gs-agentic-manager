import { useState } from "react";
import { Bot, Check, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { noContactAutofill } from "@/lib/no-contact-autofill";
import { cn } from "@/lib/utils";

export interface TeamChatCandidate {
  id: string;
  name: string;
}

export type NewTeamChatInput =
  | { mode: "direct"; userId: string }
  | { mode: "group"; title: string; userIds: string[]; agentIds: string[] }
  | { mode: "add"; userIds: string[]; agentIds: string[] };

export interface NewTeamChatDialogProps {
  /** direct: pick one person. group: name it and pick members. add: add members to a group. */
  mode: "direct" | "group" | "add";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** People who can be added, not including you. */
  people: TeamChatCandidate[];
  /** Live agents of the company; groups only. */
  agents: TeamChatCandidate[];
  onSubmit: (input: NewTeamChatInput) => Promise<void>;
}

/** "New message" (pick one person) and "New group" (name it, pick people and agents). */
export function NewTeamChatDialog({ mode, open, onOpenChange, ...props }: NewTeamChatDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="px-4 pt-4 pb-3">
          <DialogTitle>{mode === "direct" ? "New message" : mode === "group" ? "New group" : "Add members"}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {mode === "direct"
              ? "Choose who to message."
              : "Agents in a group reply only when you @mention them."}
          </DialogDescription>
        </div>
        {/* The dialog unmounts its content on close, so each opening starts empty. */}
        <NewTeamChatForm mode={mode} {...props} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewTeamChatForm({
  mode,
  people,
  agents,
  onSubmit,
  onDone,
}: Omit<NewTeamChatDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(input: NewTeamChatInput) {
    setPending(true);
    setError(null);
    try {
      await onSubmit(input);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the chat. Try again.");
    } finally {
      setPending(false);
    }
  }

  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const row = (kind: "user" | "agent", candidate: TeamChatCandidate) => {
    const key = `${kind}:${candidate.id}`;
    const selected = picked.has(key);
    const Icon = kind === "agent" ? Bot : User;
    return (
      <CommandItem
        key={key}
        value={key}
        keywords={[candidate.name]}
        data-checked={multi ? selected : undefined}
        onSelect={() => (mode === "direct" ? void submit({ mode: "direct", userId: candidate.id }) : toggle(key))}
        className="gap-3 px-3 py-2.5"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
        {multi && (
          <>
            <Check aria-hidden="true" className={cn("size-4 shrink-0", selected ? "visible" : "invisible")} />
            {selected && <span className="sr-only">Selected</span>}
          </>
        )}
      </CommandItem>
    );
  };

  const userIds = [...picked].filter((key) => key.startsWith("user:")).map((key) => key.slice(5));
  const agentIds = [...picked].filter((key) => key.startsWith("agent:")).map((key) => key.slice(6));
  const multi = mode !== "direct";
  const canCreate = (mode === "add" || title.trim().length > 0) && picked.size > 0 && !pending;

  return (
    <div className="flex flex-col">
      {mode === "group" && (
        <div className="flex flex-col gap-1.5 px-4 pb-3">
          <Label htmlFor="team-chat-title">Name</Label>
          <Input
            id="team-chat-title"
            value={title}
            maxLength={120}
            placeholder="For example, Launch plan"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
      )}
      <Command>
        <CommandInput
          aria-label={mode === "direct" ? "Search people" : "Search people and agents"}
          placeholder={mode === "direct" ? "Search people…" : "Search people and agents…"}
          {...noContactAutofill("team-chat-members")}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList className="max-h-72">
          <CommandEmpty>Nobody matches “{search}”.</CommandEmpty>
          {people.length > 0 && <CommandGroup heading="People">{people.map((person) => row("user", person))}</CommandGroup>}
          {multi && agents.length > 0 && (
            <CommandGroup heading="Agents">{agents.map((agent) => row("agent", agent))}</CommandGroup>
          )}
        </CommandList>
      </Command>
      {error && (
        <p role="alert" className="px-4 pt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {multi && (
        <DialogFooter className="border-t border-border px-4 py-3">
          <span className="mr-auto self-center text-xs text-muted-foreground">
            {picked.size === 0
              ? "Pick at least one member"
              : mode === "group" && !title.trim()
                ? `${picked.size} selected. Give the group a name`
                : `${picked.size} selected`}
          </span>
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() => void submit(mode === "add" ? { mode: "add", userIds, agentIds } : { mode: "group", title: title.trim(), userIds, agentIds })}
          >
            {pending ? "Saving…" : mode === "add" ? "Add" : "Create group"}
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}
