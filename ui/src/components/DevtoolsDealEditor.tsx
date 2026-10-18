import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PipelineCaseDetail } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { readDevtoolsDeal } from "../lib/client-case";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

// Edit a DevTools deal in GSAM (overnight run, 17 Oct). GSAM replaces
// Pipedrive, so the team needs to change the value, owner, close date and,
// most of all, schedule the next step without going back to Pipedrive.
// Nothing is written to Pipedrive.

export interface DealDraft {
  value: string;
  currency: string;
  owner: string;
  expectedClose: string;
  probability: string;
  nextActivityDate: string;
  nextActivitySubject: string;
}

function text(value: unknown) {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function draftFromFields(fields: Record<string, unknown> | null | undefined): DealDraft {
  const deal = readDevtoolsDeal(fields);
  return {
    value: deal.value == null ? "" : String(deal.value),
    currency: deal.currency ?? "",
    owner: deal.owner ?? "",
    expectedClose: deal.expectedClose?.slice(0, 10) ?? "",
    probability: deal.probability == null ? "" : String(deal.probability),
    nextActivityDate: deal.nextActivity?.slice(0, 10) ?? "",
    nextActivitySubject: text(fields?.nextActivitySubject),
  };
}

/**
 * The case fields after an edit. A Pipedrive lead keeps its lead keys; a deal
 * (or a case with neither) uses the deal keys. Cleared inputs remove the key.
 */
export function applyDealDraft(fields: Record<string, unknown> | null | undefined, draft: DealDraft) {
  const next: Record<string, unknown> = { ...(fields ?? {}) };
  const lead = "leadValue" in next && !("dealValue" in next);
  const keys = lead
    ? { value: "leadValue", currency: "leadCurrency", owner: "leadOwner" }
    : { value: "dealValue", currency: "dealCurrency", owner: "dealOwner" };
  const set = (key: string, value: unknown) => {
    if (value === "" || value == null) delete next[key];
    else next[key] = value;
  };
  const value = draft.value.trim() === "" ? null : Number(draft.value);
  if (value != null && !Number.isFinite(value)) throw new Error("Value must be a number");
  const probability = draft.probability.trim() === "" ? null : Number(draft.probability);
  if (probability != null && (!Number.isFinite(probability) || probability < 0 || probability > 100)) {
    throw new Error("Probability must be between 0 and 100");
  }
  set(keys.value, value);
  set(keys.currency, draft.currency.trim().toUpperCase());
  set(keys.owner, draft.owner.trim());
  set("expectedCloseDate", draft.expectedClose);
  set("probability", probability);
  set("nextActivityDate", draft.nextActivityDate);
  set("nextActivitySubject", draft.nextActivityDate ? draft.nextActivitySubject.trim() : "");
  return next;
}

export function DevtoolsDealEditor({ detail, label = "Edit deal" }: { detail: PipelineCaseDetail; label?: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DealDraft>(() => draftFromFields(detail.case.fields));

  const save = useMutation({
    mutationFn: async () => pipelinesApi.updateCase(detail.case.id, { fields: applyDealDraft(detail.case.fields, draft) }),
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(detail.case.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(detail.case.pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(detail.case.id) }),
      ]);
      pushToast({ title: "Deal saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not save the deal", tone: "error" }),
  });

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setDraft(draftFromFields(detail.case.fields));
          setOpen(true);
        }}
      >
        {label}
      </Button>
    );
  }

  const field = (key: keyof DealDraft, title: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`deal-edit-${key}`}>{title}</Label>
      <Input
        id={`deal-edit-${key}`}
        value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        {...props}
      />
    </div>
  );

  return (
    <form
      className="space-y-3 py-3"
      aria-label="Edit deal"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("nextActivityDate", "Next step on", { type: "date" })}
        {field("nextActivitySubject", "Next step", { placeholder: "Call to agree the pilot scope" })}
        {field("value", "Value", { inputMode: "decimal" })}
        {field("currency", "Currency", { placeholder: "GBP", maxLength: 3 })}
        {field("owner", "Owner")}
        {field("expectedClose", "Expected close", { type: "date" })}
        {field("probability", "Probability (%)", { inputMode: "numeric" })}
      </div>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save deal"}</Button>
      </div>
    </form>
  );
}

/** Today on this device as YYYY-MM-DD. */
function localDay(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Pipedrive's "mark as done" on a deal's next activity: it becomes the last
 * activity (with what happened), and the next step is the follow-up, if any.
 */
export function completeNextStep(
  fields: Record<string, unknown> | null | undefined,
  input: { note: string; nextActivityDate: string; nextActivitySubject: string },
  now: Date = new Date(),
) {
  const next: Record<string, unknown> = { ...(fields ?? {}) };
  const done = text(next.nextActivitySubject).trim();
  next.lastActivityDate = localDay(now);
  if (done) next.lastActivitySubject = done;
  else delete next.lastActivitySubject;
  if (input.note.trim()) next.lastActivityNote = input.note.trim();
  else delete next.lastActivityNote;
  if (input.nextActivityDate) {
    next.nextActivityDate = input.nextActivityDate;
    if (input.nextActivitySubject.trim()) next.nextActivitySubject = input.nextActivitySubject.trim();
    else delete next.nextActivitySubject;
  } else {
    delete next.nextActivityDate;
    delete next.nextActivitySubject;
  }
  return next;
}

export function DevtoolsNextStepDone({ detail }: { detail: PipelineCaseDetail }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [nextActivityDate, setNextActivityDate] = useState("");
  const [nextActivitySubject, setNextActivitySubject] = useState("");

  const save = useMutation({
    mutationFn: async () =>
      pipelinesApi.updateCase(detail.case.id, {
        fields: completeNextStep(detail.case.fields, { note, nextActivityDate, nextActivitySubject }),
      }),
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(detail.case.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(detail.case.pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(detail.case.id) }),
      ]);
      pushToast({ title: nextActivityDate ? "Done, and the follow-up is booked" : "Next step marked done", tone: "success" });
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not save", tone: "error" }),
  });

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setNote("");
          setNextActivityDate("");
          setNextActivitySubject("");
          setOpen(true);
        }}
      >
        Mark next step done
      </Button>
    );
  }

  return (
    <form
      className="space-y-3 py-3"
      aria-label="Mark next step done"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="deal-done-note">What happened?</Label>
        <Input id="deal-done-note" value={note} placeholder="Agreed a pilot for January" onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="deal-done-next-date">Follow-up on</Label>
          <Input id="deal-done-next-date" type="date" value={nextActivityDate} onChange={(event) => setNextActivityDate(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="deal-done-next-subject">Follow-up</Label>
          <Input
            id="deal-done-next-subject"
            value={nextActivitySubject}
            placeholder="Send the pilot proposal"
            onChange={(event) => setNextActivitySubject(event.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}
