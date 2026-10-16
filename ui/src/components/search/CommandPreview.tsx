import { ArrowLeft, Bell, Check, SquarePen, UserRound, Wand2 } from "lucide-react";
import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";
import type { CommandAgent, PaletteCommand } from "../../lib/palette-commands";

/** One line for the "Do this" suggestion in the results. */
export function describeCommand(command: PaletteCommand, lead: CommandAgent | null, currentTaskRef: string | null): string {
  switch (command.kind) {
    case "create": {
      const who = command.agent?.name ?? lead?.name;
      const due = command.due ? `, due ${command.due.label}` : "";
      return `Create a task “${command.title}”${who ? ` for ${who}` : ""}${due}`;
    }
    case "assign": {
      const task = command.taskRef === "this" ? currentTaskRef ?? "this task" : command.taskRef;
      return `Assign ${task} to ${command.toMe ? "me" : command.agent?.name ?? "?"}`;
    }
    case "remind":
      return `Remind me on ${command.when.label}: ${command.title}`;
  }
}

/** The command suggestion shown above the search results. */
export function CommandSuggestion({
  command,
  lead,
  currentTaskRef,
  typed,
  onSelect,
}: {
  command: PaletteCommand;
  lead: CommandAgent | null;
  currentTaskRef: string | null;
  /** The words in the box, so the item always matches the search filter. */
  typed: string;
  onSelect: () => void;
}) {
  return (
    <>
      <CommandGroup heading="Do this">
        <CommandItem value={`__command ${typed}`} onSelect={onSelect} data-testid="command-suggestion">
          <Wand2 className="mr-2 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{describeCommand(command, lead, currentTaskRef)}</span>
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">Preview</span>
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground">{value}</span>
    </div>
  );
}

/** What will happen, shown before anything is created or changed. */
export function CommandPreviewPanel({
  command,
  lead,
  currentTaskRef,
  busy,
  onConfirm,
  onBack,
}: {
  command: PaletteCommand;
  lead: CommandAgent | null;
  currentTaskRef: string | null;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const canRun = command.kind !== "assign" || command.taskRef !== "this" || !!currentTaskRef;
  let confirmLabel = "Create the task";
  let ConfirmIcon = SquarePen;
  let rows: Array<{ label: string; value: string }> = [];
  if (command.kind === "create") {
    const owner = command.agent ?? lead;
    rows = [
      { label: "Task", value: command.title },
      { label: "Owner", value: owner ? `${owner.name}${command.agent ? "" : " (no one named, so the team lead)"}` : "Nobody yet" },
      { label: "Due", value: command.due ? command.due.label : "No date" },
    ];
  } else if (command.kind === "assign") {
    confirmLabel = "Assign it";
    ConfirmIcon = UserRound;
    rows = [
      { label: "Task", value: command.taskRef === "this" ? currentTaskRef ?? "Open a task first, then try again" : command.taskRef },
      { label: "New owner", value: command.toMe ? "You" : command.agent?.name ?? "" },
    ];
  } else {
    confirmLabel = "Set the reminder";
    ConfirmIcon = Bell;
    rows = [
      { label: "Reminder", value: command.title },
      { label: "When", value: `${command.when.label}, 9am` },
      { label: "How", value: "A task for you, put aside until then. It comes back on that morning." },
    ];
  }
  return (
    <>
      <div className="mx-2 my-2 rounded-lg border border-border bg-muted/40 px-3 py-2" data-testid="command-preview">
        <p className="mb-1 text-xs font-medium text-muted-foreground">Nothing happens until you confirm.</p>
        {rows.map((row) => (
          <Row key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
      <CommandGroup>
        {canRun ? (
          <CommandItem value="__confirm-command" onSelect={onConfirm} disabled={busy} data-testid="command-confirm">
            {busy ? <Check className="mr-2 h-4 w-4 animate-pulse" /> : <ConfirmIcon className="mr-2 h-4 w-4" />}
            {confirmLabel}
          </CommandItem>
        ) : null}
        <CommandItem value="__cancel-command" onSelect={onBack} data-testid="command-cancel">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to search
        </CommandItem>
      </CommandGroup>
    </>
  );
}
