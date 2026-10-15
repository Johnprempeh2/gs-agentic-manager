import { useId, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { diffDraftWords, type DraftDiffSegment } from "@greatstone/shared";
import { Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { issuesApi } from "../api/issues";
import { copyTextToClipboard } from "../lib/clipboard";
import type { IssueThreadInteraction, RequestDraftReviewInteraction } from "../lib/issue-thread-interactions";
import { queryKeys } from "../lib/queryKeys";
import { formatShortDate } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Textarea } from "./ui/textarea";

function changesLabel(count: number) {
  return count === 1 ? "1 change" : `${count} changes`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={async () => {
        await copyTextToClipboard(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function WordDiff({ segments }: { segments: DraftDiffSegment[] }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-6">
      {segments.map((segment, index) =>
        segment.type === "same" ? (
          <span key={index}>{segment.text}</span>
        ) : segment.type === "added" ? (
          <ins key={index} className="rounded-sm bg-status-success-soft text-status-success-foreground no-underline">
            {segment.text}
          </ins>
        ) : (
          <del key={index} className="rounded-sm bg-status-danger-soft text-status-danger-foreground">
            {segment.text}
          </del>
        ),
      )}
    </div>
  );
}

/**
 * An agent's draft the person edits in place (GSAM editable drafts). Resolves
 * itself through the interaction accept/reject API so it behaves the same in
 * task threads, agent chats and the Decisions feed.
 */
export function DraftReviewCard({
  interaction,
  drafterLabel,
  resolvedByLabel,
  errorMessage,
}: {
  interaction: RequestDraftReviewInteraction;
  drafterLabel: string;
  resolvedByLabel?: string | null;
  errorMessage?: (error: unknown) => string | null;
}) {
  const { payload } = interaction;
  const queryClient = useQueryClient();
  const [text, setText] = useState(payload.body);
  const [learn, setLearn] = useState(true);
  const [redrafting, setRedrafting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editorId = useId();
  const changeCount = useMemo(() => diffDraftWords(payload.body, text).changeCount, [payload.body, text]);
  const edited = changeCount > 0;

  const resolve = useMutation({
    mutationFn: (action: { kind: "accept"; editedBody?: string } | { kind: "redraft"; note?: string }) =>
      action.kind === "accept"
        ? issuesApi.acceptInteraction(interaction.issueId, interaction.id, {
            ...(action.editedBody !== undefined ? { editedBody: action.editedBody } : {}),
            learnFromEdits: learn,
          })
        : issuesApi.rejectInteraction(interaction.issueId, interaction.id, action.note),
    onMutate: () => setError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(interaction.issueId),
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)),
      );
      for (const queryKey of [
        queryKeys.issues.interactions(interaction.issueId),
        queryKeys.issues.detail(interaction.issueId),
        queryKeys.issues.comments(interaction.issueId),
        queryKeys.issues.activeRun(interaction.issueId),
        queryKeys.issues.liveRuns(interaction.issueId),
        queryKeys.attention(interaction.companyId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (err) => setError(errorMessage?.(err) ?? (err instanceof Error ? err.message : "Could not send. Try again.")),
  });
  const working = resolve.isPending;

  const meta = [
    payload.channel,
    payload.recipients?.length ? `to ${payload.recipients.join(", ")}` : null,
  ].filter(Boolean);

  const header = (
    <div className="mb-3 space-y-1">
      <p className="text-xs text-muted-foreground">
        Drafted by <span className="font-medium text-foreground">{drafterLabel}</span> for{" "}
        <span className="font-medium text-foreground">{payload.purpose}</span>
        {meta.length ? ` · ${meta.join(" · ")}` : ""}
      </p>
      {payload.subject ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Subject: </span>
          {payload.subject}
        </p>
      ) : null}
    </div>
  );

  if (interaction.status !== "pending") {
    const draft = interaction.result?.draft ?? null;
    const finalText = draft?.finalBody ?? payload.body;
    const outcome =
      interaction.status === "rejected"
        ? "Redraft requested"
        : interaction.status === "accepted"
          ? draft?.edited
            ? `Edits sent (${changesLabel(draft.changeCount)})`
            : "Approved as is"
          : "Closed";
    return (
      <div data-testid="draft-review-card">
        {header}
        <div className="whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm leading-6">
          {finalText}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="mr-auto text-xs text-muted-foreground">
            {outcome}
            {resolvedByLabel ? ` by ${resolvedByLabel}` : ""}
            {interaction.resolvedAt ? ` on ${formatShortDate(interaction.resolvedAt)}` : ""}
          </p>
          <CopyButton text={finalText} />
        </div>
        {interaction.status === "rejected" && interaction.result?.reason ? (
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Note: </span>
            {interaction.result.reason}
          </p>
        ) : null}
        {draft?.edited ? (
          <Collapsible className="mt-2">
            <CollapsibleTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="group -ml-2">
                <ChevronRight aria-hidden className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
                What changed
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <WordDiff segments={draft.diff} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="draft-review-card">
      {header}
      <label htmlFor={editorId} className="sr-only">
        Draft text, editable
      </label>
      <Textarea
        id={editorId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && edited && !working) {
            event.preventDefault();
            resolve.mutate({ kind: "accept", editedBody: text });
          }
        }}
        disabled={working}
        className="max-h-[60vh] min-h-32 overflow-y-auto leading-6"
        spellCheck
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {edited ? changesLabel(changeCount) : "No changes yet"}
        </span>
        <CopyButton text={text} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="mr-auto text-sm">
          {edited ? `Send your edits to ${drafterLabel}?` : "Edit the draft above to send changes back."}
        </p>
        {edited ? (
          <>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={learn} onCheckedChange={(value) => setLearn(value === true)} />
              Let {drafterLabel} learn from my edits
            </label>
            <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setText(payload.body)}>
              Undo edits
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={working || !edited}
          onClick={() => resolve.mutate({ kind: "accept", editedBody: text })}
        >
          {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          Send edits
        </Button>
      </div>

      {redrafting ? (
        <div className="mt-3 space-y-2">
          <label htmlFor={`${editorId}-note`} className="text-xs text-muted-foreground">
            What should {drafterLabel} change? (optional)
          </label>
          <Textarea
            id={`${editorId}-note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="For example: shorter, warmer, mention the June start"
            autoFocus
            disabled={working}
          />
        </div>
      ) : null}

      <div aria-live="assertive">
        {error ? (
          <p className="mt-2 rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {redrafting ? (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setRedrafting(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => resolve.mutate({ kind: "redraft", note: note.trim() || undefined })}
            >
              Send redraft request
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => setRedrafting(true)}>
              Ask for a redraft
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={working || edited}
              title={edited ? "Undo your edits to approve the original" : undefined}
              onClick={() => resolve.mutate({ kind: "accept" })}
            >
              Approve as is
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
