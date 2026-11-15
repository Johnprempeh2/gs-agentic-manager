import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
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

/**
 * "Escalate to owner" (Ben's access, Nov 2026): on a task, a review or an
 * approval. A short note is required; the server hands the item to the owner,
 * puts a card on their Desk and records it in activity.
 */
export function EscalateToOwnerButton({
  what,
  ownerName,
  onEscalate,
  onDone,
  size = "sm",
}: {
  /** "task", "review" or "approval": used in the dialog text. */
  what: "task" | "review" | "approval";
  ownerName?: string | null;
  onEscalate: (note: string) => Promise<unknown>;
  onDone?: () => void;
  size?: "xs" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const owner = ownerName?.trim() || "the owner";
  const Owner = owner.charAt(0).toUpperCase() + owner.slice(1);
  const mutation = useMutation({
    mutationFn: () => onEscalate(note.trim()),
    onSuccess: () => {
      setOpen(false);
      setNote("");
      onDone?.();
    },
  });
  const tooShort = note.trim().length < 3;

  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={() => setOpen(true)} data-escalate-to-owner={what}>
        <ArrowUpRight className="size-3.5" aria-hidden />
        Escalate to {ownerName?.trim() ? owner : "owner"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Escalate this {what} to {owner}</DialogTitle>
            <DialogDescription>
              {what === "review"
                ? `${Owner} becomes the reviewer instead of you.`
                : what === "approval"
                  ? `${Owner} decides it instead of you.`
                  : `The task is handed to ${owner}, with a card on their Desk.`}{" "}
              They see your note, and it is recorded in the activity log.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={noteId} className="text-sm font-medium">
            Why are you escalating it?
          </label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A sentence is enough, for example: the client asked for a discount I cannot agree."
            rows={3}
            maxLength={1000}
            autoFocus
          />
          {mutation.error ? (
            <p className="text-sm text-destructive" role="alert">{(mutation.error as Error).message}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => mutation.mutate()} disabled={tooShort || mutation.isPending}>
              {mutation.isPending ? "Escalating…" : `Escalate to ${owner}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
