import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PenLine } from "lucide-react";
import type { WebsiteChangeRequestResult, WebsitePage } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import type { WebsiteFrameBlockPick } from "../../lib/website-frame-host";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorStateMessage } from "../ErrorState";

// Click to change (GRE-2121, plan 3.4). The person picks a block in the
// preview, says what to change, and sees it back before anything is made.
// Confirm makes one task for the website agent; Cancel makes nothing. A
// change to words or an image can go straight into the draft instead.

type Step = "describe" | "confirm" | "created";

/** A v4 UUID. `randomUUID` needs a secure context; a phone on plain http has only `getRandomValues`. */
function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function WebsiteChangeRequestPanel({
  companyId,
  siteId,
  page,
  pick,
  onCancel,
  onEditBlock,
}: {
  companyId: string;
  siteId: string;
  page: WebsitePage;
  pick: WebsiteFrameBlockPick;
  /** Clears the pick. Nothing is created. */
  onCancel: () => void;
  /** Opens the block in the editor for a words or image change. */
  onEditBlock: (blockId: string) => void;
}) {
  const [step, setStep] = useState<Step>("describe");
  const [request, setRequest] = useState("");
  // One id per pick: a repeated confirm returns the same task, never a second one.
  const [requestId] = useState(newRequestId);
  const [created, setCreated] = useState<WebsiteChangeRequestResult | null>(null);
  const { ref } = pick;
  const blockName = pick.label.trim() || ref.blockType;
  const panelRef = useRef<HTMLElement>(null);

  // On a phone the panel sits below the page controls; bring it into view on each pick.
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);

  const submit = useMutation({
    mutationFn: () =>
      websiteModuleApi.requestChange(companyId, siteId, page.id, {
        requestId,
        pageRevisionId: ref.pageRevisionId,
        blockId: ref.blockId,
        blockType: ref.blockType,
        blockLabel: pick.label.trim().slice(0, 200) || undefined,
        engine: ref.engine,
        source: ref.source,
        request: request.trim(),
      }),
    onSuccess: (result) => {
      setCreated(result);
      setStep("created");
    },
  });

  const block = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium" data-testid="website-change-block">
        {blockName} on {page.title}
      </p>
      <p className="truncate text-xs text-muted-foreground">{ref.blockType}</p>
    </div>
  );

  return (
    <section
      ref={panelRef}
      aria-label="Ask for a change"
      data-testid="website-change-request"
      data-step={step}
      className="scroll-mt-20 space-y-3 rounded-lg border border-primary/40 bg-card p-3 shadow-xs"
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">Selected block</span>
        <div className="min-w-0 flex-1">{block}</div>
      </div>

      {step === "describe" ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (request.trim()) setStep("confirm");
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">What should change?</span>
            <Textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              maxLength={4000}
              rows={3}
              placeholder="For example: make the heading shorter and use our new tagline."
              autoFocus
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!request.trim()}>Review</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="button" size="sm" variant="outline" className="sm:ml-auto" onClick={() => onEditBlock(ref.blockId)}>
              <PenLine />
              Edit words or image myself
            </Button>
          </div>
        </form>
      ) : null}

      {step === "confirm" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">The website agent gets this task</p>
            <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm" data-testid="website-change-summary">
              {request.trim()}
            </blockquote>
            <p className="text-xs text-muted-foreground">
              The website agent will change this on {page.title} ({page.slug}). Nothing goes live until a person publishes it.
            </p>
          </div>
          {submit.error ? (
            <p role="alert" className="text-sm text-status-danger-foreground">
              The task was not created: {errorStateMessage(submit.error)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? "Creating task" : "Create task"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={submit.isPending} onClick={() => setStep("describe")}>Back</Button>
            <Button type="button" size="sm" variant="ghost" disabled={submit.isPending} onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {step === "created" && created ? (
        <div role="status" className="space-y-3">
          <p className="text-sm">
            Task{" "}
            <Link to={issueUrl({ id: created.issueId, identifier: created.identifier })} className="font-medium underline underline-offset-2">
              {created.identifier ?? "created"}
            </Link>{" "}
            {created.assigneeAgentId ? "is with the website agent." : "is created. No website agent leads this site's project yet, so assign it on the task."}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>Done</Button>
        </div>
      ) : null}
    </section>
  );
}
