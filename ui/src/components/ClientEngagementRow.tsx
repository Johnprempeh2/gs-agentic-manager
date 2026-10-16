import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, FileUp } from "lucide-react";
import type { ClientEngagement, ClientJourneyFileRef, EngagementStatus } from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate } from "../lib/utils";
import { Button } from "./ui/button";

// The engagement pack after the NDA (Ben, 8 and 12 Oct): it goes out once the
// NDA is accepted or suspended, then the client accepts it. Each step can be
// recorded by uploading the file (the pack, the signed acceptance) or by a
// plain "mark" when it happened by email.

const STEPS: { value: EngagementStatus; label: string }[] = [
  { value: "not_sent", label: "Not sent" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
];

const NOT_SENT: ClientEngagement = {
  status: "not_sent",
  sentAt: null,
  acceptedAt: null,
  changedBy: null,
  changedAt: null,
  pack: null,
  acceptance: null,
};

function day(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

export function engagementSummary(engagement: ClientEngagement, ndaCleared: boolean) {
  if (engagement.status === "accepted") {
    return `Accepted ${day(engagement.acceptedAt)}${engagement.sentAt ? `, sent ${day(engagement.sentAt)}` : ""}.`;
  }
  if (engagement.status === "sent") return `Sent ${day(engagement.sentAt)}. Waiting for the client to accept.`;
  return ndaCleared
    ? "Ready to send. Upload the pack you sent, or mark it sent."
    : "Waiting for the NDA. The pack goes out once the NDA is accepted or suspended.";
}

function FileLine({ file, label }: { file: ClientJourneyFileRef; label: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs">
      <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden="true" />
      <span className="text-muted-foreground">{label}:</span>
      <a href={file.contentPath} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:underline">
        {file.title}
      </a>
      <span className="text-muted-foreground">Uploaded {day(file.uploadedAt)}</span>
    </p>
  );
}

export function ClientEngagementRow({
  caseId,
  engagement = NOT_SENT,
  ndaCleared,
}: {
  caseId: string;
  engagement?: ClientEngagement;
  ndaCleared: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const packInput = useRef<HTMLInputElement>(null);
  const acceptanceInput = useRef<HTMLInputElement>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseJourney(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseFiles(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
    ]);
  const failed = (title: string) => (error: unknown) =>
    pushToast({
      title,
      body: error instanceof Error ? error.message : "Only board users can change a client's engagement pack.",
      tone: "error",
    });

  const setStatus = useMutation({
    mutationFn: (status: EngagementStatus) => pipelinesApi.setCaseEngagement(caseId, status),
    onSuccess: refresh,
    onError: failed("Could not change the engagement pack"),
  });
  const upload = useMutation({
    mutationFn: ({ step, file }: { step: "pack" | "acceptance"; file: File }) =>
      pipelinesApi.uploadEngagementFile(caseId, step, file),
    onSuccess: async (_result, { step }) => {
      pushToast({
        title: step === "pack" ? "Engagement pack saved and marked sent" : "Signed acceptance saved",
        tone: "success",
      });
      await refresh();
    },
    onError: failed("Could not save the file"),
  });
  const busy = setStatus.isPending || upload.isPending;
  const status = engagement.status;

  const fileInput = (step: "pack" | "acceptance", ref: typeof packInput, label: string) => (
    <input
      ref={ref}
      type="file"
      accept="application/pdf,image/*,.doc,.docx"
      className="hidden"
      aria-label={label}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) upload.mutate({ step, file });
      }}
    />
  );

  return (
    <div className="space-y-2 py-3 text-sm" data-testid="journey-engagement" data-engagement-status={status}>
      <div className="flex flex-wrap items-center gap-3">
        <span id="journey-engagement-label" className="font-medium text-foreground">Engagement pack</span>
        <div role="radiogroup" aria-labelledby="journey-engagement-label" className="inline-flex rounded-md border border-border p-0.5">
          {STEPS.map((step) => {
            const checked = status === step.value;
            const blocked = step.value !== "not_sent" && !ndaCleared;
            return (
              <button
                key={step.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy || blocked}
                title={blocked ? "The NDA must be accepted or suspended first" : undefined}
                onClick={() => {
                  if (!checked) setStatus.mutate(step.value);
                }}
                className={cn(
                  "rounded-sm px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  checked ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {step.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="journey-engagement-summary">
        {engagementSummary(engagement, ndaCleared)}
      </p>
      {engagement.pack ? <FileLine file={engagement.pack} label="Pack" /> : null}
      {engagement.acceptance ? <FileLine file={engagement.acceptance} label="Signed acceptance" /> : null}
      {ndaCleared ? (
        <div className="flex flex-wrap gap-2">
          {status !== "accepted" ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => packInput.current?.click()}>
              <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {engagement.pack ? "Replace the pack" : "Upload the pack"}
            </Button>
          ) : null}
          {status !== "not_sent" ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => acceptanceInput.current?.click()}>
              <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {engagement.acceptance ? "Replace the signed acceptance" : "Upload the signed acceptance"}
            </Button>
          ) : null}
          {fileInput("pack", packInput, "Upload the engagement pack")}
          {fileInput("acceptance", acceptanceInput, "Upload the signed acceptance")}
        </div>
      ) : null}
    </div>
  );
}
