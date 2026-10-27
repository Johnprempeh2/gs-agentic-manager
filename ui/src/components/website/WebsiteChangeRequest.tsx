import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eraser, PenLine, Pencil } from "lucide-react";
import type { CreateWebsiteChangeRequest, WebsiteChangeRequestResult, WebsiteCommentWidth, WebsitePage } from "@greatstone/shared";
import { issuesApi } from "../../api/issues";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorStateMessage } from "../ErrorState";
import { markupDocument, markupJsonFile, markupSummary, pngSize, renderMarkupPng, type MarkupShape } from "../../lib/website-markup";
import { WebsiteMarkupLayer } from "./WebsiteMarkupLayer";
import {
  MAX_ATTACHMENTS,
  imageFileProblem,
  pastedImageFiles,
  requestAttachments,
  uniqueImageFile,
  type DraftAttachment,
  type NewDraftAttachment,
} from "../../lib/website-change-attachments";
import { WebsiteChangeAttachments, type WebsiteChangeEffect } from "./WebsiteChangeAttachments";

// Click to change (GRE-2121, plan 3.4). The person picks a block in the
// preview, says what to change, and sees it back before anything is made.
// Confirm makes one task for the website agent; Cancel makes nothing. A
// change to words or an image can go straight into the draft instead.
//
// Ask an agent (GRE-2350) is the same box from the full-screen editor's top
// bar: the selected block, or with nothing selected the whole page. The task
// is a comment on the page; the Comments drawer lists the open ones.
//
// GRE-2361: on Create task GSAM asks the site's editor for a PNG of the block
// or the page and attaches it to the task. An older engine, or no answer in
// 5 s, makes the task without one, and the task says so.
//
// GRE-2518: the screenshot is taken as the box opens and shown over the page
// with drawing tools. One Send button (or Cmd/Ctrl+Enter) makes the task with
// the words, the screenshot, the marked-up PNG and the drawing's vector JSON.
//
// GRE-2527: the person can also paste or upload images, pick one from Website
// media or GS Studio, add a reference site or an effect, each with a note. The
// request lists them; uploads go to the task through the website route, which
// checks the type and size again.

/** What the comment is about: a block (picked in preview or selected in the editor) or the whole page. */
export type WebsiteChangeTarget =
  | { kind: "page" }
  | {
      kind: "block";
      blockId: string;
      blockType: string;
      label: string;
      /** From a preview pick: the revision the frame showed. Else the page's latest draft. */
      pageRevisionId?: string;
      engine?: CreateWebsiteChangeRequest["engine"];
      source?: CreateWebsiteChangeRequest["source"];
    };

const WIDTH_NAMES: Record<WebsiteCommentWidth, string> = { laptop: "Laptop", tablet: "Tablet", phone: "Phone" };

/** A screenshot the editor captured, ready to attach and to draw on. */
export interface WebsiteScreenshot {
  file: File;
  width: number;
  /** The PNG as a data URL, shown under the drawing. */
  url: string;
}

/** The frame's checked PNG data URL as a file to attach, e.g. `website-hero-1.png`. */
export function websiteScreenshotFile(dataUrl: string, name: string): File {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], `website-${name}.png`, { type: "image/png" });
}

/** A v4 UUID. `randomUUID` needs a secure context; a phone on plain http has only `getRandomValues`. */
function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SEND_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ Enter" : "Ctrl Enter";

/** What became of the files: the screenshot and drawing attached, the person's images, and the ones that did not upload. */
type Attached = { files: "none" | "screenshot" | "drawing"; images: number; failed: string[] };

let draftKeys = 0;
const nextDraftKey = () => `attachment-${(draftKeys += 1)}`;
const previewUrlOf = (file: File) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "");
const revokePreview = (draft: DraftAttachment) => {
  if (draft.kind === "upload" && draft.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(draft.previewUrl);
};

export function WebsiteChangeRequestPanel({
  companyId,
  siteId,
  page,
  target,
  initialRequest,
  width,
  displayWidth = null,
  dirty = false,
  capture,
  markupHost = null,
  effects = [],
  onCancel,
  onEditBlock,
}: {
  companyId: string;
  siteId: string;
  page: WebsitePage;
  target: WebsiteChangeTarget;
  /** Words to start the request with, for example a Background choice by library id (GRE-2526). */
  initialRequest?: string;
  /** The editor width the person sees the page at. */
  width: WebsiteCommentWidth;
  /** That width in CSS pixels, or null when the page fills the canvas. */
  displayWidth?: number | null;
  /** The editor has edits that are not saved: the task names the saved draft. */
  dirty?: boolean;
  /** Asks the site's editor for a screenshot; null when it cannot give one. */
  capture?: () => Promise<WebsiteScreenshot | null>;
  /** Where the drawing layer goes: over the page in the editor. None: no drawing. */
  markupHost?: HTMLElement | null;
  /** The site's effects library, from the site's editor. Empty: no Effect button. */
  effects?: readonly WebsiteChangeEffect[];
  /** Clears the pick. Nothing is created. */
  onCancel: () => void;
  /** Opens the block in the editor for a words or image change (preview picks only). */
  onEditBlock?: (blockId: string, blockName: string) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"describe" | "created">("describe");
  const [request, setRequest] = useState(initialRequest ?? "");
  // One id per pick: a repeated send returns the same task, never a second one.
  const [requestId] = useState(newRequestId);
  const [created, setCreated] = useState<WebsiteChangeRequestResult | null>(null);
  const [attached, setAttached] = useState<Attached>({ files: "none", images: 0, failed: [] });
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [attachProblem, setAttachProblem] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const block = target.kind === "block" ? target : null;
  const blockName = block ? block.label.trim() || block.blockType : "The whole page";
  const pageRevisionId = block?.pageRevisionId ?? page.latestRevisionId;
  const fileStem = block ? block.blockId : "page";
  const panelRef = useRef<HTMLElement>(null);

  // The screenshot is taken once, as the box opens: it is what the person draws on and what the task gets.
  const shotRef = useRef<Promise<WebsiteScreenshot | null> | null>(null);
  if (!shotRef.current) shotRef.current = capture ? capture().catch(() => null) : Promise.resolve(null);
  const [shot, setShot] = useState<{ status: "pending" } | { status: "none" } | { status: "ready"; screenshot: WebsiteScreenshot; size: { width: number; height: number } }>(
    capture ? { status: "pending" } : { status: "none" },
  );
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [drawing, setDrawing] = useState(false);
  const canDraw = shot.status === "ready" && markupHost !== null;

  useEffect(() => {
    let live = true;
    void shotRef.current!.then((screenshot) => {
      if (!live) return;
      const size = screenshot ? pngSize(screenshot.url) : null;
      if (!screenshot || !size) return setShot({ status: "none" });
      setShot({ status: "ready", screenshot, size });
      setDrawing(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // The previews of uploaded images live as long as the box.
  useEffect(() => () => draftsRef.current.forEach(revokePreview), []);

  const addFiles = (files: File[], pasted = false) => {
    const room = MAX_ATTACHMENTS - draftsRef.current.length;
    const problems: string[] = [];
    const taken = draftsRef.current.flatMap((draft) => (draft.kind === "upload" ? [draft.file.name] : []));
    const added: DraftAttachment[] = [];
    for (const file of files) {
      const problem = imageFileProblem(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (added.length >= room) {
        problems.push(`Only ${MAX_ATTACHMENTS} attachments fit on one request.`);
        break;
      }
      const named = uniqueImageFile(file, taken, pasted);
      taken.push(named.name);
      added.push({ key: nextDraftKey(), kind: "upload", file: named, previewUrl: previewUrlOf(named), note: "" });
    }
    if (added.length > 0) setDrafts((current) => [...current, ...added]);
    setAttachProblem(problems.length > 0 ? problems.join(" ") : null);
  };
  const addDraft = (draft: NewDraftAttachment) => {
    if (draftsRef.current.length >= MAX_ATTACHMENTS) return;
    setDrafts((current) => [...current, { ...draft, key: nextDraftKey(), note: "" }]);
    setAttachProblem(null);
  };
  const setNote = (key: string, note: string) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, note } : draft)));
  const removeDraft = (key: string) =>
    setDrafts((current) => {
      const gone = current.find((draft) => draft.key === key);
      if (gone) revokePreview(gone);
      return current.filter((draft) => draft.key !== key);
    });

  // On a phone the panel sits below the page controls; bring it into view on each pick.
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);

  const words = request.trim();
  const drawn = canDraw ? shapes : [];
  const canSend = Boolean(pageRevisionId) && (words.length > 0 || drawn.length > 0 || drafts.length > 0);

  const submit = useMutation({
    mutationFn: async () => {
      const screenshot = await shotRef.current!;
      const markup = screenshot ? markupSummary(drawn) : undefined;
      const sentDrafts = drafts;
      const attachments = requestAttachments(sentDrafts);
      const result = await websiteModuleApi.requestChange(companyId, siteId, page.id, {
        requestId,
        pageRevisionId: pageRevisionId!,
        ...(block
          ? {
              blockId: block.blockId,
              blockType: block.blockType,
              blockLabel: block.label.trim().slice(0, 200) || undefined,
              ...(block.engine ? { engine: block.engine } : {}),
              ...(block.source !== undefined ? { source: block.source } : {}),
            }
          : {}),
        width,
        request: words,
        ...(screenshot ? { screenshot: true } : {}),
        ...(markup ? { markup } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      const files: { file: File | null; name: string; image?: true }[] = [];
      if (screenshot) {
        files.push({ file: screenshot.file, name: "the screenshot" });
        const size = pngSize(screenshot.url);
        if (markup && size) {
          const png = await renderMarkupPng(screenshot.url, drawn, fileStem).catch(() => null);
          files.push({ file: png, name: "the marked-up screenshot" });
          files.push({ file: markupJsonFile(markupDocument(drawn, size, width), fileStem), name: "the drawing's vector file" });
        }
      }
      for (const draft of sentDrafts) {
        if (draft.kind === "upload") files.push({ file: draft.file, name: draft.file.name, image: true });
      }
      const failed: string[] = [];
      let reason = "";
      for (const { file, name, image } of files) {
        if (!file) {
          failed.push(`${name} (this browser could not draw it)`);
          continue;
        }
        try {
          if (image) await websiteModuleApi.uploadChangeImage(companyId, siteId, page.id, result.issueId, file);
          else await issuesApi.uploadAttachment(companyId, result.issueId, file);
        } catch (error) {
          reason = errorStateMessage(error);
          failed.push(`${name} (${reason})`);
        }
      }
      const images = files.filter((file) => file.image).length;
      setAttached({ files: !screenshot ? "none" : markup ? "drawing" : "screenshot", images, failed });
      if (failed.length > 0) {
        // The task says these are attached: correct it on the task, so the agent is not left looking.
        const none = failed.length === files.length && images === 0;
        await issuesApi
          .addComment(
            result.issueId,
            none
              ? `The screenshot did not upload (${reason}). No screenshot is attached to this task.`
              : `Not every file uploaded. Missing: ${failed.join("; ")}. Use the files that are attached and the description.`,
          )
          .catch(() => undefined);
      }
      return result;
    },
    onSuccess: (result) => {
      setCreated(result);
      setStep("created");
      setDrawing(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.pageComments(companyId, siteId, page.id) });
    },
  });

  const send = () => {
    if (canSend && !submit.isPending) submit.mutate();
  };

  const subject = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium" data-testid="website-change-block">
        {blockName} on {page.title}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {block ? `${block.blockType} · ` : ""}Seen at {WIDTH_NAMES[width]} width
      </p>
    </div>
  );

  const marks = shapes.length === 1 ? "1 mark" : `${shapes.length} marks`;
  const subjectName = block ? "the block" : "the page";

  return (
    <section
      ref={panelRef}
      aria-label="Ask an agent"
      data-testid="website-change-request"
      data-step={step}
      className="scroll-mt-20 space-y-3 rounded-lg border border-primary/40 bg-card p-3 shadow-xs"
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
          {block ? "Selected block" : "Whole page"}
        </span>
        <div className="min-w-0 flex-1">{subject}</div>
      </div>

      {!pageRevisionId ? (
        <p role="alert" className="text-sm text-status-warning-foreground">
          This page has no saved draft yet. Save it once, then ask an agent.
        </p>
      ) : dirty && step !== "created" ? (
        <p className="text-xs text-status-warning-foreground" data-testid="website-change-unsaved">
          Your unsaved edits are not in the task. Save first if the agent should see them.
        </p>
      ) : null}

      {step === "describe" ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          onPaste={(event) => {
            if (submit.isPending) return;
            const files = pastedImageFiles(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files, true);
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">What should change?</span>
            <Textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  send();
                }
              }}
              maxLength={4000}
              rows={3}
              placeholder="Describe or draw what you want changed"
              autoFocus
            />
          </label>

          <div className="space-y-1.5" data-testid="website-change-drawing" data-state={shot.status}>
            {shot.status === "pending" ? (
              <p className="text-xs text-muted-foreground">Taking a screenshot of {subjectName} to draw on…</p>
            ) : canDraw ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" aria-pressed={drawing} onClick={() => setDrawing((open) => !open)}>
                  <Pencil />
                  {drawing ? "Hide drawing tools" : shapes.length > 0 ? "Edit drawing" : "Draw on the page"}
                </Button>
                {shapes.length > 0 ? (
                  <>
                    <span className="text-xs text-muted-foreground">Your drawing: {marks}</span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setShapes([])}>
                      <Eraser />
                      Clear
                    </Button>
                  </>
                ) : drawing ? (
                  <span className="text-xs text-muted-foreground">Draw on the screenshot of {subjectName}.</span>
                ) : null}
              </div>
            ) : capture ? (
              <p className="text-xs text-muted-foreground">
                This site&apos;s editor did not send a screenshot, so there is nothing to draw on. Describe the change in words.
              </p>
            ) : null}
          </div>

          <WebsiteChangeAttachments
            companyId={companyId}
            siteId={siteId}
            drafts={drafts}
            effects={effects}
            problem={attachProblem}
            disabled={submit.isPending}
            onAddFiles={(files) => addFiles(files)}
            onAdd={addDraft}
            onNote={setNote}
            onRemove={removeDraft}
          />

          {submit.error ? (
            <p role="alert" className="text-sm text-status-danger-foreground">
              The task was not created: {errorStateMessage(submit.error)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!canSend || submit.isPending}>
              {submit.isPending ? "Sending" : "Send"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={submit.isPending} onClick={onCancel}>Cancel</Button>
            <span className="hidden text-xs text-muted-foreground sm:inline">{SEND_KEYS} sends</span>
            {block && onEditBlock ? (
              <Button type="button" size="sm" variant="outline" className="sm:ml-auto" onClick={() => onEditBlock(block.blockId, blockName)}>
                <PenLine />
                Edit words or image myself
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            The website agent changes {block ? "this" : "the page"} on {page.title} ({page.slug}) as a draft for you to see here. Nothing goes live until a person publishes it.
          </p>
        </form>
      ) : null}

      {step === "created" && created ? (
        <div role="status" className="space-y-3">
          <p className="text-sm">
            Task{" "}
            <Link to={issueUrl({ id: created.issueId, identifier: created.identifier })} className="font-medium underline underline-offset-2">
              {created.identifier ?? "created"}
            </Link>{" "}
            {created.assigneeAgentId
              ? "is with the website agent. Its replies show under Comments."
              : "is created. No website agent leads this site's project yet, so assign it on the task."}
          </p>
          {attached.files !== "none" && attached.failed.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="website-change-screenshot">
              {attached.files === "drawing"
                ? `A screenshot of ${subjectName} and your drawing are attached to the task.`
                : `A screenshot of ${subjectName} is attached to the task.`}
            </p>
          ) : attached.failed.length > 0 ? (
            <p className="text-xs text-status-warning-foreground" data-testid="website-change-screenshot">
              {attached.files === "screenshot" && attached.images === 0 ? "The screenshot did not upload" : "Some files did not upload"}: {attached.failed.join("; ")}. The task says so.
            </p>
          ) : null}
          {attached.images > 0 && attached.failed.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="website-change-images">
              {attached.images === 1 ? "Your image is attached to the task." : `Your ${attached.images} images are attached to the task.`}
            </p>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>Done</Button>
        </div>
      ) : null}

      {drawing && canDraw && shot.status === "ready" && step === "describe"
        ? createPortal(
            <WebsiteMarkupLayer
              screenshotUrl={shot.screenshot.url}
              size={shot.size}
              displayWidth={displayWidth}
              shapes={shapes}
              onChange={setShapes}
              onDone={() => setDrawing(false)}
            />,
            markupHost!,
          )
        : null}
    </section>
  );
}
