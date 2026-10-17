import { useState } from "react";
import { CalendarClock } from "lucide-react";
import type { IssueUnblockDescriptor, IssueUnblockWaitingOn } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { localToday } from "../lib/calendar";
import { WAITING_ON_CHOICES, buildWaitingDescriptor } from "../lib/waiting-date";

interface WaitingDateEditorProps {
  issue: { id: string; assigneeAgentId?: string | null; unblockDescriptor?: IssueUnblockDescriptor | null };
  pending?: boolean;
  onSave: (descriptor: IssueUnblockDescriptor) => void;
}

/**
 * "Set a waiting date" under the why-blocked box: who the task waits on and the
 * day it should hear back by. When the day passes, the assignee is woken once
 * to chase it, so nobody has to remember.
 */
export function WaitingDateEditor({ issue, pending, onSave }: WaitingDateEditorProps) {
  const existing = issue.unblockDescriptor ?? null;
  const [open, setOpen] = useState(false);
  const [waitingOn, setWaitingOn] = useState<IssueUnblockWaitingOn>(existing?.waitingOn ?? "client");
  const [expectedBy, setExpectedBy] = useState(existing?.expectedBy ?? "");

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mt-1"
        title="Say who this task waits on and when to chase. The agent is woken when the day passes."
        onClick={() => setOpen(true)}
      >
        <CalendarClock className="size-3.5" />
        {existing?.expectedBy ? "Change the waiting date" : "Set a waiting date"}
      </Button>
    );
  }

  const save = (date: string | null) => {
    onSave(buildWaitingDescriptor(issue, waitingOn, date));
    setOpen(false);
  };

  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-3 rounded-md border border-border px-3 py-2.5"
      aria-label="Waiting date"
      onSubmit={(event) => {
        event.preventDefault();
        if (expectedBy) save(expectedBy);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`waiting-on-${issue.id}`}>Waiting on</Label>
        <NativeSelect
          id={`waiting-on-${issue.id}`}
          value={waitingOn}
          onChange={(event) => setWaitingOn(event.target.value as IssueUnblockWaitingOn)}
        >
          {WAITING_ON_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`waiting-until-${issue.id}`}>Chase on</Label>
        <Input
          id={`waiting-until-${issue.id}`}
          type="date"
          min={localToday()}
          value={expectedBy}
          onChange={(event) => setExpectedBy(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!expectedBy || pending}>
          Save
        </Button>
        {existing?.expectedBy ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => save(null)}>
            Remove the date
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <p className="basis-full text-xs text-muted-foreground">
        When the day passes, the agent on this task is woken once to chase it.
      </p>
    </form>
  );
}
