import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_IMAGE_PROMPT_MIN_LENGTH,
  imageShapeLabel,
  type GeneratedImage,
  type ImageAspectRatio,
} from "@greatstone/shared";
import {
  AlertCircle,
  Download,
  ImageIcon,
  Loader2,
  RotateCcw,
  Trash2,
  Wand2,
} from "lucide-react";
import { imagesApi } from "../api/images";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeTime } from "@/lib/utils";
import { IMAGE_ASPECT_STYLE, IMAGE_IDEA_STARTERS, ImagePromptFields } from "../components/ImagePromptFields";

export { IMAGE_IDEA_STARTERS };

const ASPECT_STYLE = IMAGE_ASPECT_STYLE;

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function downloadName(image: GeneratedImage) {
  const slug = image.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug || "image"}.png`;
}

function NotSetUp({ provider }: { provider?: string | null }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm" data-testid="images-not-set-up">
      <p className="font-medium text-foreground">Image making is not switched on yet</p>
      <p className="mt-1 text-muted-foreground">
        Ask whoever runs GSAM to connect an image service. Once it is on, you and your agents can make images here.
      </p>
      <details className="mt-3 text-muted-foreground">
        <summary className="cursor-pointer text-xs font-medium">For whoever runs GSAM</summary>
        <p className="mt-2 text-xs">
          Set <code>HIGGSFIELD_API_KEY_ID</code> and <code>HIGGSFIELD_API_KEY_SECRET</code> (from cloud.higgsfield.ai) in the
          server environment and restart. {provider ? null : "To try the page without a key, set GSAM_IMAGE_PROVIDER=mock."}
        </p>
      </details>
    </div>
  );
}

function ImageCard({
  image,
  makerName,
  onOpen,
  onRetry,
  retrying,
}: {
  image: GeneratedImage;
  makerName: string;
  onOpen: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <figure className="gs-glass-card group flex flex-col overflow-hidden rounded-lg border bg-card" data-testid="generated-image-card">
      <div className="relative w-full overflow-hidden bg-muted" style={{ aspectRatio: ASPECT_STYLE[image.aspectRatio] ?? "1 / 1" }}>
        {image.status === "completed" && image.contentPath ? (
          <button type="button" onClick={onOpen} className="block h-full w-full" aria-label={`Open image: ${image.prompt}`}>
            <img
              src={image.contentPath}
              alt={image.prompt}
              loading="lazy"
              className="h-full w-full object-cover transition-transform motion-safe:duration-300 group-hover:scale-105"
            />
          </button>
        ) : image.status === "pending" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground motion-safe:animate-pulse" role="status">
            <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden="true" />
            <span className="text-xs">Making your image...</span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">{image.error ?? "This image could not be made."}</p>
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        )}
      </div>
      <figcaption className="space-y-1 p-3">
        <p className="line-clamp-2 text-sm text-foreground" title={image.prompt}>
          {image.prompt}
        </p>
        <p className="text-xs text-muted-foreground">
          {imageShapeLabel(image.aspectRatio)} · {makerName} · {relativeTime(image.createdAt)}
        </p>
      </figcaption>
    </figure>
  );
}

export function Images() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const toast = useOptionalToastActions();
  const pushToast = toast?.pushToast ?? (() => null);
  const queryClient = useQueryClient();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Images" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";
  const statusQuery = useQuery({
    queryKey: queryKeys.images.status(companyId),
    queryFn: () => imagesApi.status(companyId),
    enabled: !!selectedCompanyId,
  });
  const listQuery = useQuery({
    queryKey: queryKeys.images.list(companyId),
    queryFn: () => imagesApi.list(companyId, { limit: 120 }),
    enabled: !!selectedCompanyId,
    // Keep checking while any image is still being made.
    refetchInterval: (query) =>
      query.state.data?.images.some((image) => image.status === "pending") ? 3_000 : false,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const currentUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const makerName = useCallback(
    (image: GeneratedImage) =>
      image.createdByAgentId
        ? agentNames.get(image.createdByAgentId) ?? "An agent"
        : image.createdByUserId && image.createdByUserId === currentUserId
          ? "You"
          : "A teammate",
    [agentNames, currentUserId],
  );

  const create = useMutation({
    mutationFn: (input: { prompt: string; aspectRatio: ImageAspectRatio }) => imagesApi.create(companyId, input),
    onSuccess: (image) => {
      queryClient.setQueryData(queryKeys.images.list(companyId), (current: Awaited<ReturnType<typeof imagesApi.list>> | undefined) =>
        current ? { ...current, images: [image, ...current.images], total: current.total + 1 } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
    },
    onError: (error) => pushToast({ title: errorMessage(error), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => imagesApi.remove(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      setOpenId(null);
      pushToast({ title: "Image deleted", tone: "success", ttlMs: 2500 });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
    },
    onError: (error) => pushToast({ title: errorMessage(error), tone: "error" }),
  });

  const configured = statusQuery.data?.configured === true;
  const trimmed = prompt.trim();
  const canSubmit = configured && trimmed.length >= GENERATED_IMAGE_PROMPT_MIN_LENGTH && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate({ prompt: trimmed, aspectRatio }, { onSuccess: () => setPrompt("") });
  };

  const reuse = (image: GeneratedImage) => {
    setPrompt(image.prompt);
    setAspectRatio(image.aspectRatio);
    setOpenId(null);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={ImageIcon} message="Select an organisation to make images." />;
  }
  if (statusQuery.isLoading || listQuery.isLoading) return <PageSkeleton />;
  if (listQuery.error) {
    return <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} retrying={listQuery.isFetching} />;
  }

  const images = listQuery.data?.images ?? [];
  const opened = images.find((image) => image.id === openId) ?? null;
  const toDelete = images.find((image) => image.id === confirmDeleteId) ?? null;

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">Images</h1>
        <p className="text-sm text-muted-foreground">
          Describe a picture and GSAM makes it for you. Your agents can make them for their tasks too.
        </p>
      </header>

      <section className="gs-glass-card space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="images-composer-title">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 id="images-composer-title" className="text-sm font-semibold">Make an image</h2>
          {statusQuery.data?.providerLabel ? (
            <span className="ml-auto text-xs text-muted-foreground">Using {statusQuery.data.providerLabel}</span>
          ) : null}
        </div>

        {!configured ? <NotSetUp provider={statusQuery.data?.provider} /> : null}

        <ImagePromptFields
          ref={promptRef}
          idPrefix="image"
          prompt={prompt}
          onPromptChange={setPrompt}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          onSubmitShortcut={submit}
          disabled={!configured}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Usually ready in under a minute. You can leave this page; it keeps going.
          </p>
          <Button onClick={submit} disabled={!canSubmit} data-testid="make-image">
            {create.isPending ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Wand2 className="h-4 w-4" aria-hidden="true" />
            )}
            Make image
          </Button>
        </div>
      </section>

      {images.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No images yet"
          message="Images you and your agents make will appear here, ready to download or reuse."
        />
      ) : (
        <section aria-label="Your images" className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {images.map((image) => (
            <ImageCard
              key={image.id}
              image={image}
              makerName={makerName(image)}
              onOpen={() => setOpenId(image.id)}
              onRetry={() => create.mutate({ prompt: image.prompt, aspectRatio: image.aspectRatio })}
              retrying={create.isPending || !configured}
            />
          ))}
        </section>
      )}

      <Dialog open={!!opened} onOpenChange={(open) => (!open ? setOpenId(null) : undefined)}>
        <DialogContent className="max-w-4xl">
          {opened ? (
            <>
              <DialogHeader>
                <DialogTitle>Image</DialogTitle>
                <DialogDescription className="whitespace-pre-wrap">{opened.prompt}</DialogDescription>
              </DialogHeader>
              {opened.contentPath ? (
                <img src={opened.contentPath} alt={opened.prompt} className="max-h-(--sz-70vh) w-full rounded-md object-contain" />
              ) : null}
              <p className="text-xs text-muted-foreground">
                {imageShapeLabel(opened.aspectRatio)} · Made by {makerName(opened)} · {relativeTime(opened.createdAt)}
              </p>
              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="ghost" onClick={() => setConfirmDeleteId(opened.id)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => reuse(opened)}>
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Make another like this
                  </Button>
                  {opened.contentPath ? (
                    <Button asChild>
                      <a href={opened.contentPath} download={downloadName(opened)}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                  ) : null}
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(open) => (!open ? setConfirmDeleteId(null) : undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this image?</DialogTitle>
            <DialogDescription>
              It will be removed from Images for everyone. Copies already attached to tasks stay where they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => toDelete && remove.mutate(toDelete.id)}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
