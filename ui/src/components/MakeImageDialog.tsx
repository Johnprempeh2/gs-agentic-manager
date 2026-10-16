import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_IMAGE_PROMPT_MIN_LENGTH,
  type GeneratedImage,
  type ImageAspectRatio,
  type ImageStylePresetId,
} from "@greatstone/shared";
import { AlertCircle, Check, ImageIcon, Loader2, PaperclipIcon, RotateCcw, Wand2 } from "lucide-react";
import { imagesApi } from "../api/images";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IMAGE_ASPECT_STYLE, ImagePromptFields } from "./ImagePromptFields";

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function fileNameFor(image: GeneratedImage, contentType: string) {
  const slug = image.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  return `${slug || "image"}.${extension}`;
}

/** Fetches a finished image and wraps it as a File, ready for the normal attachment upload. */
export async function generatedImageToFile(image: GeneratedImage, fetchImpl: typeof fetch = fetch): Promise<File> {
  if (!image.contentPath) throw new Error("The image is not ready yet");
  const response = await fetchImpl(image.contentPath, { credentials: "include" });
  if (!response.ok) throw new Error("Could not fetch the image. Please try again.");
  const blob = await response.blob();
  const contentType = blob.type || "image/png";
  return new File([blob], fileNameFor(image, contentType), { type: contentType });
}

interface MakeImageDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adds the finished image where the dialog was opened from, such as a task. */
  onAttach: (file: File) => Promise<unknown>;
  /** Names the place, for the button and the copy: "this task". */
  attachLabel?: string;
  /** Links the image to this task, so the gallery can show where it came from. */
  issueId?: string | null;
}

type Step = "compose" | "making" | "ready" | "failed" | "attached";

/**
 * Make an image without leaving the page: describe it, wait, then add it to the
 * task. The image is also kept in Images, so nothing is lost if the dialog closes.
 */
export function MakeImageDialog({
  companyId,
  open,
  onOpenChange,
  onAttach,
  attachLabel = "this task",
  issueId = null,
}: MakeImageDialogProps) {
  const queryClient = useQueryClient();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("16:9");
  const [style, setStyle] = useState<ImageStylePresetId | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    if (!open) return;
    setImageId(null);
    setAttached(false);
    setAttachError(null);
  }, [open]);

  const imageQuery = useQuery({
    queryKey: queryKeys.images.detail(imageId ?? ""),
    queryFn: () => imagesApi.get(imageId!),
    enabled: open && !!imageId,
    refetchInterval: (query) => (query.state.data?.status === "pending" || !query.state.data ? 2_500 : false),
  });

  const create = useMutation({
    mutationFn: () =>
      imagesApi.create(companyId, {
        prompt: prompt.trim(),
        aspectRatio,
        ...(style ? { style } : {}),
        ...(issueId ? { issueId } : {}),
      }),
    onSuccess: (image) => {
      setImageId(image.id);
      queryClient.setQueryData(queryKeys.images.detail(image.id), image);
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
    },
  });

  const attach = useMutation({
    mutationFn: async (image: GeneratedImage) => onAttach(await generatedImageToFile(image)),
    onSuccess: () => {
      setAttached(true);
      setAttachError(null);
    },
    onError: (error) => setAttachError(errorMessage(error)),
  });

  const image = imageQuery.data ?? null;
  const step: Step = attached
    ? "attached"
    : !imageId
      ? "compose"
      : image?.status === "completed"
        ? "ready"
        : image?.status === "failed"
          ? "failed"
          : "making";

  const canSubmit = prompt.trim().length >= GENERATED_IMAGE_PROMPT_MIN_LENGTH && !create.isPending;
  const submit = () => {
    if (canSubmit) create.mutate();
  };
  const startOver = () => {
    setImageId(null);
    setAttached(false);
    setAttachError(null);
    create.reset();
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="make-image-dialog">
        <DialogHeader>
          <DialogTitle>Make an image</DialogTitle>
          <DialogDescription>
            Describe the picture and it is added to {attachLabel} when you are happy with it. It is also kept in Images.
          </DialogDescription>
        </DialogHeader>

        {step === "compose" ? (
          <div className="space-y-4">
            <ImagePromptFields
              ref={promptRef}
              idPrefix="make-image-dialog"
              prompt={prompt}
              onPromptChange={setPrompt}
              aspectRatio={aspectRatio}
              onAspectRatioChange={setAspectRatio}
              style={style}
              onStyleChange={setStyle}
              onSubmitShortcut={submit}
              compact
            />
            {create.error ? (
              <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                {errorMessage(create.error)}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className="relative mx-auto w-full max-w-lg overflow-hidden rounded-md bg-muted"
              style={{ aspectRatio: IMAGE_ASPECT_STYLE[image?.aspectRatio ?? aspectRatio] }}
            >
              {step === "making" ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground" role="status">
                  <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden="true" />
                  <span className="text-sm">Making your image...</span>
                  <span className="text-xs">Usually under a minute. You can close this; it keeps going in Images.</span>
                </div>
              ) : step === "failed" ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center" role="alert">
                  <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">{image?.error ?? "This image could not be made."}</p>
                </div>
              ) : image?.contentPath ? (
                <img src={image.contentPath} alt={image.prompt} className="h-full w-full object-contain" />
              ) : null}
            </div>
            <p className="line-clamp-2 text-center text-xs text-muted-foreground">{image?.prompt ?? prompt}</p>
            {step === "attached" ? (
              <p className="flex items-center justify-center gap-2 text-sm text-foreground" role="status">
                <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                Added to {attachLabel}
              </p>
            ) : null}
            {attachError ? (
              <p className="flex items-center justify-center gap-2 text-sm text-destructive" role="alert">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                {attachError}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {step === "compose" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!canSubmit} data-testid="make-image-dialog-submit">
                {create.isPending ? (
                  <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <Wand2 className="h-4 w-4" aria-hidden="true" />
                )}
                Make image
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={startOver} disabled={step === "making"}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {step === "failed" ? "Change and try again" : "Make a different one"}
              </Button>
              {step === "attached" ? (
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              ) : (
                <Button
                  onClick={() => image && attach.mutate(image)}
                  disabled={step !== "ready" || attach.isPending}
                  data-testid="make-image-dialog-attach"
                >
                  {attach.isPending ? (
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                  ) : (
                    <PaperclipIcon className="h-4 w-4" aria-hidden="true" />
                  )}
                  Add to {attachLabel}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Make an image" button that opens the dialog. Hidden until image making is switched on. */
export function MakeImageButton({
  companyId,
  onAttach,
  attachLabel,
  disabled,
  issueId,
}: {
  companyId: string;
  onAttach: (file: File) => Promise<unknown>;
  attachLabel?: string;
  disabled?: boolean;
  issueId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: queryKeys.images.status(companyId),
    queryFn: () => imagesApi.status(companyId),
    enabled: !!companyId,
    staleTime: 5 * 60_000,
  });
  if (status.data?.configured !== true) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="shadow-none"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid="make-image-button"
      >
        <ImageIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Make an image</span>
        <span className="sm:hidden">Image</span>
      </Button>
      <MakeImageDialog
        companyId={companyId}
        open={open}
        onOpenChange={setOpen}
        onAttach={onAttach}
        attachLabel={attachLabel}
        issueId={issueId}
      />
    </>
  );
}
