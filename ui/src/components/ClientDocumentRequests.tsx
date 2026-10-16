import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, ClipboardCopy, ListPlus, Trash2, Upload } from "lucide-react";
import type { ClientDocumentRequest, ClientJourneyStage } from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import { formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Documents to collect from the client at one stage (Ben, 12 Oct: the deep
// dive's document request stage collects a set list). Each line is ticked
// off when its file is uploaded against it; the outstanding list copies as
// a ready-made email paragraph.

/** The outstanding documents as a short paragraph for an email to the client. */
export function outstandingRequestsText(requests: Pick<ClientDocumentRequest, "title" | "note" | "received">[]) {
  const open = requests.filter((request) => !request.received);
  if (open.length === 0) return "";
  const lines = open.map((request) => `- ${request.title}${request.note ? ` (${request.note})` : ""}`);
  return ["Could you please send us the following documents:", ...lines].join("\n");
}

/** Pasted text becomes one request per line; list bullets are dropped. */
export function splitRequestTitles(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function RequestRow({
  request,
  busy,
  onUpload,
  onRemove,
}: {
  request: ClientDocumentRequest;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const received = request.received;
  return (
    <li className="flex items-start gap-2 py-1 text-sm" data-testid="document-request">
      {received ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-status-success" aria-hidden="true" />
      ) : (
        <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{request.title}</span>
        {request.note ? <span className="block text-xs text-muted-foreground">{request.note}</span> : null}
        {received ? (
          <span className="block text-xs text-muted-foreground">
            Received {formatDate(new Date(received.receivedAt))}
            {received.contentPath ? (
              <>
                {": "}
                <a
                  href={received.contentPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground hover:underline"
                >
                  {received.title}
                </a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      {!received ? (
        <>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            aria-label={`Upload ${request.title}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={busy}
        aria-label={`Stop asking for ${request.title}`}
        title="Stop asking for this"
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

export function ClientDocumentRequests({
  caseId,
  stage,
}: {
  caseId: string;
  stage: Pick<ClientJourneyStage, "id" | "name" | "state" | "requests" | "suggestedRequests">;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const copyList = async (text: string) => {
    try {
      await copyTextToClipboard(text);
      pushToast({ title: "List copied for your email", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy the list", body: "Select and copy it by hand.", tone: "error" });
    }
  };
  const requests = stage.requests ?? [];
  const suggested = stage.suggestedRequests ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseJourney(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseFiles(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
    ]);
  const onError = (error: unknown) =>
    pushToast({
      title: "That did not save",
      body: error instanceof Error ? error.message : "Please try again.",
      tone: "error",
    });

  const ask = useMutation({
    mutationFn: (titles: string[]) => pipelinesApi.requestCaseDocuments(caseId, { stageId: stage.id, titles }),
    onSuccess: async (result) => {
      setDraft("");
      setAdding(false);
      if (result.created === 0) pushToast({ title: "Already on the list", tone: "info" });
      await invalidate();
    },
    onError,
  });
  const addStandard = useMutation({
    mutationFn: () => pipelinesApi.addStandardCaseDocumentRequests(caseId, stage.id),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: (requestId: string) => pipelinesApi.removeCaseDocumentRequest(caseId, requestId),
    onSuccess: invalidate,
    onError,
  });
  const upload = useMutation({
    mutationFn: ({ request, file }: { request: ClientDocumentRequest; file: File }) =>
      pipelinesApi.uploadCaseEvidence(caseId, file, { stageId: stage.id, requestId: request.id }),
    onSuccess: async (_item, { request }) => {
      pushToast({ title: `${request.title} received`, tone: "success" });
      await invalidate();
    },
    onError: (error: unknown) =>
      pushToast({
        title: "Upload failed",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });
  const busy = ask.isPending || addStandard.isPending || remove.isPending || upload.isPending;

  // A stage that has not started, with nothing asked and no standard list, stays quiet.
  if (requests.length === 0 && suggested.length === 0 && stage.state === "next") return null;

  const received = requests.filter((request) => request.received).length;
  const outstanding = outstandingRequestsText(requests);
  const titles = splitRequestTitles(draft);

  return (
    <div className="mt-2 rounded-md border border-border p-2" data-testid="document-requests">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground">Documents to collect</p>
        {requests.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {received} of {requests.length} received
          </span>
        ) : null}
        {outstanding ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void copyList(outstanding)}
          >
            <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
            Copy the list for an email
          </Button>
        ) : null}
      </div>
      {requests.length > 0 ? (
        <ul className="mt-1" aria-label={`${stage.name} documents to collect`}>
          {requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              busy={busy}
              onUpload={(file) => upload.mutate({ request, file })}
              onRemove={() => remove.mutate(request.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          List what you need from the client here. Each item is ticked off when its file is uploaded.
        </p>
      )}
      {suggested.length > 0 ? (
        <div className="mt-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => addStandard.mutate()}>
            <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Add the usual {stage.name} list ({suggested.length})
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">{suggested.map((item) => item.title).join(", ")}</p>
        </div>
      ) : null}
      {adding ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (titles.length > 0) ask.mutate(titles);
          }}
        >
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              const pasted = splitRequestTitles(text);
              if (pasted.length > 1) {
                event.preventDefault();
                ask.mutate(pasted);
              }
            }}
            placeholder="For example: Latest management accounts"
            aria-label="Document to ask for"
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={busy || titles.length === 0}>
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setDraft("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={() => setAdding(true)}>
          Ask for a document
        </Button>
      )}
    </div>
  );
}
