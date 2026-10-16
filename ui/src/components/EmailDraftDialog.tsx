import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { mailboxesApi } from "../api/mailboxes";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

// An email to a client, saved as a draft in one of the company's mailboxes
// (the mailbox drafts tool). Nothing is sent from here: the person reviews and
// sends it from their own mail app.

export interface EmailDraftSeed {
  to: string[];
  subject: string;
  text: string;
}

/** Split a typed recipient list on commas, semicolons or spaces. */
export function splitRecipients(value: string) {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function EmailDraftDialog({
  open,
  onOpenChange,
  companyId,
  title,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  title: string;
  seed: EmailDraftSeed;
}) {
  const { pushToast } = useToastActions();
  const mailboxes = useQuery({
    queryKey: queryKeys.mailboxes.list(companyId),
    queryFn: () => mailboxesApi.list(companyId),
    enabled: open,
  });
  const usable = (mailboxes.data ?? []).filter((mailbox) => mailbox.allowDrafts);
  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");

  // Each opening starts from the latest seed.
  useEffect(() => {
    if (!open) return;
    setTo(seed.to.join(", "));
    setSubject(seed.subject);
    setText(seed.text);
  }, [open, seed.to, seed.subject, seed.text]);
  const chosen = mailboxId && usable.some((mailbox) => mailbox.id === mailboxId) ? mailboxId : usable[0]?.id ?? "";

  const save = useMutation({
    mutationFn: () =>
      mailboxesApi.saveDraft(companyId, chosen, { to: splitRecipients(to), cc: [], subject: subject.trim(), text }),
    onSuccess: (result) => {
      pushToast({
        title: "Draft saved",
        body: `It is in ${result.folder}. Nothing was sent: review and send it from your mail app.`,
        tone: "success",
      });
      onOpenChange(false);
    },
    onError: (error) =>
      pushToast({
        title: "Could not save the draft",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });
  const ready = Boolean(chosen) && splitRecipients(to).length > 0 && subject.trim().length > 0 && text.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Saved as a draft in your mailbox. Nothing is sent until you send it yourself.
            </DialogDescription>
          </DialogHeader>
          {mailboxes.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading mailboxes...</p>
          ) : usable.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="email-draft-no-mailbox">
              No mailbox takes drafts yet. Turn on drafts for a mailbox in{" "}
              <Link to="/apps/mailboxes" className="text-foreground underline">Apps, Mailboxes</Link>, then try again.
            </p>
          ) : (
            <form
              id="email-draft-form"
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (ready) save.mutate();
              }}
            >
              {usable.length > 1 ? (
                <div className="space-y-1">
                  <Label htmlFor="email-draft-mailbox">Save in</Label>
                  <NativeSelect id="email-draft-mailbox" value={chosen} onChange={(event) => setMailboxId(event.target.value)}>
                    {usable.map((mailbox) => (
                      <option key={mailbox.id} value={mailbox.id}>{mailbox.label || mailbox.address}</option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Saving in {usable[0]!.label || usable[0]!.address}.</p>
              )}
              <div className="space-y-1">
                <Label htmlFor="email-draft-to">To</Label>
                <Input id="email-draft-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@client.com" />
                {seed.to.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No contact with an email address on this client yet.</p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="email-draft-subject">Subject</Label>
                <Input id="email-draft-subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="email-draft-text">Message</Label>
                <Textarea id="email-draft-text" rows={10} value={text} onChange={(event) => setText(event.target.value)} />
              </div>
            </form>
          )}
          <DialogFooter className="flex-row justify-between sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {usable.length > 0 ? (
              <Button type="submit" form="email-draft-form" disabled={!ready || save.isPending}>
                {save.isPending ? "Saving..." : "Save as draft"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
