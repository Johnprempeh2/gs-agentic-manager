import { useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

export interface ApprovalNoteRequest {
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  /** When true the note must be filled in before the action can be sent. */
  required?: boolean;
  destructive?: boolean;
}

/**
 * Asks for a short note to send back to the agent with a decision, such as
 * why a request was rejected or what should change.
 */
export function ApprovalNoteDialog({
  request,
  pending,
  onCancel,
  onSubmit,
}: {
  request: ApprovalNoteRequest | null;
  pending?: boolean;
  onCancel: () => void;
  onSubmit: (note: string | undefined) => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      {request ? (
        <ApprovalNoteForm key={request.title} request={request} pending={pending} onCancel={onCancel} onSubmit={onSubmit} />
      ) : null}
    </Dialog>
  );
}

function ApprovalNoteForm({
  request,
  pending,
  onCancel,
  onSubmit,
}: {
  request: ApprovalNoteRequest;
  pending?: boolean;
  onCancel: () => void;
  onSubmit: (note: string | undefined) => void;
}) {
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  const canSubmit = !pending && (!request.required || trimmed.length > 0);
  return (
    <DialogContent className="sm:max-w-md">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit(trimmed || undefined);
        }}
      >
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>{request.description}</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{request.label}</span>
          <Textarea
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={request.placeholder}
            rows={3}
            disabled={pending}
          />
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant={request.destructive ? "destructive" : "default"} disabled={!canSubmit}>
            {request.confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
