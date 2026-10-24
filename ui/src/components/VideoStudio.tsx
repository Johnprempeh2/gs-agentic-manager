import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_VIDEO_PROMPT_MAX_LENGTH,
  GENERATED_VIDEO_PROMPT_MIN_LENGTH,
  HIGGSFIELD_PLAN_LABEL,
  hasStudioCamera,
  LOCAL_GPU_LABEL,
  studioCameraLabel,
  VIDEO_MODELS,
  VIDEO_MOTION_PRESETS,
  videoModel,
  videoModelLabel,
  videoMotionLabel,
  type GeneratedImage,
  type GeneratedVideo,
  type GeneratedVideosResponse,
  type StudioCameraSettings,
  type VideoModelId,
  type VideoMotionPresetId,
} from "@greatstone/shared";
import { Bookmark, Camera, CircleStop, Cpu, Download, Film, Globe, Loader2, Move3d, Star, Timer, Trash2, X } from "lucide-react";
import { videosApi } from "../api/videos";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { studioClipItems, type StudioMediaItem } from "../lib/website-studio-media";
import { UseOnWebsiteDialog } from "./website/WebsiteStudioMedia";
import { StudioCameraFields } from "./StudioCameraFields";
import { StudioLookPicker } from "./StudioLookPicker";
import { StudioPlanBar } from "./StudioPlanBar";
import { STUDIO_GENERATE_CLASS, STUDIO_PROMPT_CLASS, StudioComposer, type StudioComposerChip } from "./StudioComposer";
import { STUDIO_GALLERY_CLASS, StudioEmptyGallery, StudioMediaAction, StudioMediaCard } from "./StudioMediaCard";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn, relativeTime } from "@/lib/utils";

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function downloadName(video: GeneratedVideo) {
  const slug = video.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug || "clip"}.mp4`;
}

/** What a pending clip is doing; local clips say their place in the queue and how far along they are. */
export function pendingLabel(video: GeneratedVideo): string {
  const progress = video.progress;
  if (!progress) return "Making your video...";
  if (progress.queuePosition > 0) {
    return `Waiting for this PC's graphics card (${progress.queuePosition} ahead)`;
  }
  return progress.percent === null ? "Starting on this PC..." : `Making your video on this PC: ${progress.percent}%`;
}

/** Ready-made clip ideas for the empty gallery. */
const VIDEO_IDEA_STARTERS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "City at dusk", prompt: "A red double-decker bus crossing Westminster Bridge at dusk, light rain, reflections on the road" },
  { label: "Product turn", prompt: "A sleek water bottle turning slowly on a white surface, soft studio light, clean background" },
  { label: "Nature", prompt: "Waves rolling onto dark rocks at sunrise, mist over the sea, calm and slow" },
  { label: "Team moment", prompt: "A small team laughing around a table in a bright modern office, natural light, gentle movement" },
];

interface VideoStudioProps {
  companyId: string;
  /** A finished studio image to animate, picked from the image gallery. */
  sourceImage: GeneratedImage | null;
  onClearSourceImage: () => void;
  onError: (message: string) => void;
  onDeleted?: () => void;
  /** "Use on website" made a media entry from a clip. */
  onSentToWebsite?: (message: string) => void;
}

/**
 * The studio's moving-picture side: a short clip from a description, or a
 * finished image brought to life. Clips take a few minutes, so the list keeps
 * checking while any is still being made.
 */
export function VideoStudio({ companyId, sourceImage, onClearSourceImage, onError, onDeleted, onSentToWebsite }: VideoStudioProps) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<VideoModelId>("kling-2.5-turbo-pro");
  const [duration, setDuration] = useState<number | null>(null);
  const [motion, setMotion] = useState<VideoMotionPresetId | null>(null);
  const [camera, setCamera] = useState<StudioCameraSettings>({});
  const [lookId, setLookId] = useState<string | null>(null);
  const [lookName, setLookName] = useState<string | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [websiteItem, setWebsiteItem] = useState<StudioMediaItem | null>(null);
  // With both Higgsfield services there, the studio uses the plan unless the person switches.
  const [preferPlan, setPreferPlan] = useState(true);
  const filters = favouritesOnly ? { favourite: true } : {};

  const statusQuery = useQuery({
    queryKey: queryKeys.videos.status(companyId),
    queryFn: () => videosApi.status(companyId),
  });
  const listQuery = useQuery({
    queryKey: queryKeys.videos.list(companyId, filters),
    queryFn: () => videosApi.list(companyId, { limit: 60, ...filters }),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => (query.state.data?.videos.some((video) => video.status === "pending") ? 5_000 : false),
  });

  const model = videoModel(modelId)!;
  // A model that only animates images cannot be used without one. This PC's
  // models are offered only while its ComfyUI answers; the paid ones only when
  // their service is set up.
  const cloudReady = !!statusQuery.data?.provider && statusQuery.data.provider !== "local";
  const localReady = statusQuery.data?.local?.videoModels ?? [];
  const usableModels = VIDEO_MODELS.filter(
    (item) =>
      (sourceImage || item.textPath) && (item.provider === "local" ? localReady.includes(item.id) : cloudReady || !statusQuery.data),
  );
  const fallbackModel = usableModels[0] ?? VIDEO_MODELS[0];
  const effectiveModel = usableModels.some((item) => item.id === modelId) ? model : videoModel(fallbackModel.id)!;
  const effectiveDuration = duration && (effectiveModel.durations as readonly number[]).includes(duration) ? duration : effectiveModel.durations[0];
  const plan = statusQuery.data?.plan ?? null;
  const alsoAvailable = statusQuery.data?.alsoAvailable ?? null;
  // Models on this PC never use the plan.
  const onThisPc = effectiveModel.provider === "local";
  const usingPlan = !!plan && !onThisPc && (preferPlan || !alsoAvailable);
  const planEmpty = usingPlan && plan.credits !== null && plan.credits <= 0;
  const provider = plan && !onThisPc ? (usingPlan ? ("higgsfield_plan" as const) : alsoAvailable?.provider) : undefined;
  const refreshPlan = () => {
    if (plan) void queryClient.invalidateQueries({ queryKey: queryKeys.videos.status(companyId) });
  };

  const create = useMutation({
    mutationFn: () =>
      videosApi.create(companyId, {
        prompt: prompt.trim(),
        model: effectiveModel.id,
        duration: effectiveDuration,
        ...(motion ? { motion } : {}),
        ...(hasStudioCamera(camera) ? { camera } : {}),
        ...(lookId ? { lookId } : {}),
        ...(sourceImage ? { sourceImageId: sourceImage.id } : {}),
        ...(sourceImage?.issue ? { issueId: sourceImage.issue.id } : {}),
        ...(sourceImage?.organisation ? { organisationId: sourceImage.organisation.id } : {}),
        ...(provider ? { provider } : {}),
      }),
    onSuccess: () => {
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) });
      refreshPlan();
    },
    onError: (error) => onError(errorMessage(error)),
  });

  const retry = useMutation({
    mutationFn: (video: GeneratedVideo) =>
      videosApi.create(companyId, {
        prompt: video.prompt,
        model: video.model,
        duration: video.durationSeconds,
        ...(video.motion ? { motion: video.motion } : {}),
        ...(video.camera ? { camera: video.camera } : {}),
        ...(video.sourceImage ? { sourceImageId: video.sourceImage.id } : {}),
        ...(provider ? { provider } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) });
      refreshPlan();
    },
    onError: (error) => onError(errorMessage(error)),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => videosApi.cancel(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) }),
    onError: (error) => onError(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => videosApi.remove(id),
    onSuccess: () => {
      onDeleted?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) });
    },
    onError: (error) => onError(errorMessage(error)),
  });

  const favourite = useMutation({
    mutationFn: ({ id, favourite: value }: { id: string; favourite: boolean }) => videosApi.setFavourite(id, { favourite: value }),
    onMutate: async ({ id, favourite: value }) => {
      // Fill the star straight away (after any refetch in flight, which would undo it).
      await queryClient.cancelQueries({ queryKey: queryKeys.videos.list(companyId) });
      queryClient.setQueriesData<GeneratedVideosResponse>({ queryKey: queryKeys.videos.list(companyId) }, (current) =>
        current
          ? { ...current, videos: current.videos.map((video) => (video.id === id ? { ...video, favourite: value } : video)) }
          : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) }),
    onError: (error) => onError(errorMessage(error)),
  });

  const configured = statusQuery.data?.configured === true;
  const canSubmit = configured && !planEmpty && prompt.trim().length >= GENERATED_VIDEO_PROMPT_MIN_LENGTH && !create.isPending;
  const videos = listQuery.data?.videos ?? [];

  const pickedModelLabel = videoModelLabel(effectiveModel.id);
  const chips: StudioComposerChip[] = [
    {
      id: "motion",
      icon: Move3d,
      label: "Camera movement",
      value: videoMotionLabel(motion),
      panel: (
        <fieldset className="space-y-2" disabled={!configured}>
          <legend className="text-sm font-medium">Camera movement</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Camera movement" data-testid="video-motion">
            {[{ id: null, label: "Let it decide" }, ...VIDEO_MOTION_PRESETS].map((preset) => {
              const selected = motion === preset.id;
              return (
                <button
                  key={preset.id ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setMotion(preset.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:text-subtle-foreground",
                    selected ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:bg-accent/40",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ),
    },
    {
      id: "model",
      icon: Cpu,
      label: "Model",
      value: pickedModelLabel,
      panel: (
        <label className="block space-y-1 text-sm font-medium" htmlFor="video-model">
          <span className="block">Model</span>
          <NativeSelect
            id="video-model"
            value={effectiveModel.id}
            disabled={!configured}
            onChange={(event) => setModelId(event.target.value as VideoModelId)}
            data-testid="video-model"
          >
            {usableModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}: {item.hint}
              </option>
            ))}
          </NativeSelect>
        </label>
      ),
    },
    {
      id: "length",
      icon: Timer,
      label: "Length",
      value: `${effectiveDuration} seconds`,
      panel: (
        <fieldset className="space-y-2" disabled={!configured}>
          <legend className="text-sm font-medium">Length</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="Length" data-testid="video-duration">
            {effectiveModel.durations.map((seconds) => (
              <button
                key={seconds}
                type="button"
                role="radio"
                aria-checked={effectiveDuration === seconds}
                onClick={() => setDuration(seconds)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:text-subtle-foreground",
                  effectiveDuration === seconds ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:bg-accent/40",
                )}
              >
                {seconds} seconds
              </button>
            ))}
          </div>
        </fieldset>
      ),
    },
    {
      id: "look",
      icon: Bookmark,
      label: "House look",
      value: lookId ? lookName : null,
      panel: (
        <StudioLookPicker
          companyId={companyId}
          idPrefix="video"
          lookId={lookId}
          onPick={(look) => {
            setLookId(look?.id ?? null);
            setLookName(look?.name ?? null);
            setCamera(look?.camera ?? {});
          }}
          current={{ camera }}
          disabled={!configured}
        />
      ),
    },
    {
      id: "camera",
      icon: Camera,
      label: "Camera",
      value: studioCameraLabel(camera),
      panel: <StudioCameraFields idPrefix="video" camera={camera} onCameraChange={setCamera} disabled={!configured} />,
    },
  ];

  return (
    // display: contents on a phone, so the docked composer belongs to the page column (see Images).
    <div className="flex flex-col gap-6 max-md:contents">
      {!configured && statusQuery.isSuccess ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm" data-testid="videos-not-set-up">
          <p className="font-medium text-foreground">Video making is not switched on yet</p>
          <p className="mt-1 text-muted-foreground">
            It uses the same Higgsfield key as images. Once whoever runs GSAM adds it, you and your agents can make clips here.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-6 max-md:contents">
        <StudioComposer
          title={sourceImage ? "Bring an image to life" : "Make a video"}
          aside={
            effectiveModel.provider === "local" && localReady.includes(effectiveModel.id)
              ? `Using ${LOCAL_GPU_LABEL}, no cost`
              : plan && !onThisPc
                ? `Using ${usingPlan ? HIGGSFIELD_PLAN_LABEL : alsoAvailable?.providerLabel}`
                : statusQuery.data?.providerLabel
                  ? `Using ${statusQuery.data.providerLabel}`
                  : null
          }
          chips={chips}
          openChip={openChip}
          onOpenChipChange={setOpenChip}
          footnote="Clips usually take a few minutes. You can leave this page; it keeps going."
          notice={
            <>
              {plan && !onThisPc ? (
                <StudioPlanBar
                  companyId={companyId}
                  plan={plan}
                  alsoAvailable={alsoAvailable}
                  usingPlan={usingPlan}
                  onUsingPlanChange={setPreferPlan}
                  cost={plan.creditsPerClip[effectiveModel.id]?.[effectiveDuration] ?? null}
                  onError={(error) => onError(errorMessage(error))}
                />
              ) : null}
              {sourceImage ? (
                <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-2" data-testid="video-source-image">
                  {sourceImage.contentPath ? (
                    <img src={sourceImage.contentPath} alt={sourceImage.altText} className="h-12 w-16 shrink-0 rounded-md object-cover" />
                  ) : null}
                  <p className="min-w-0 flex-1 truncate text-sm">{sourceImage.prompt}</p>
                  <Button variant="ghost" size="sm" onClick={onClearSourceImage} aria-label="Stop using this image">
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </>
          }
          action={
            <Button onClick={() => create.mutate()} disabled={!canSubmit} className={STUDIO_GENERATE_CLASS} data-testid="make-video">
              {create.isPending ? (
                <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Film className="h-4 w-4" aria-hidden="true" />
              )}
              {sourceImage ? "Animate image" : "Make video"}
            </Button>
          }
        >
          <label htmlFor="video-prompt" className="sr-only">
            {sourceImage ? "What should happen in the picture?" : "What should the clip show?"}
          </label>
          <Textarea
            id="video-prompt"
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
                event.preventDefault();
                create.mutate();
              }
            }}
            placeholder={
              sourceImage
                ? "What should happen? For example: the steam rises from the coffee and the light shifts gently"
                : "Describe the clip. For example: a red double-decker bus crossing Westminster Bridge at dusk, light rain"
            }
            maxLength={GENERATED_VIDEO_PROMPT_MAX_LENGTH}
            rows={2}
            disabled={!configured}
            className={STUDIO_PROMPT_CLASS}
            data-testid="video-prompt"
          />
        </StudioComposer>

        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-base font-semibold">
              {favouritesOnly ? "Favourite clips" : "Your videos"}
              {videos.length > 0 ? <span className="ml-2 text-sm font-medium text-muted-foreground">{videos.length}</span> : null}
            </h2>
            {videos.length > 0 || favouritesOnly ? (
              <Button
                variant={favouritesOnly ? "default" : "outline"}
                aria-pressed={favouritesOnly}
                onClick={() => setFavouritesOnly((value) => !value)}
                className="rounded-full"
                data-testid="video-favourites-filter"
              >
                <Star className={favouritesOnly ? "h-4 w-4 fill-current" : "h-4 w-4"} aria-hidden="true" />
                Favourites
              </Button>
            ) : null}
          </div>

          {videos.length === 0 ? (
            favouritesOnly ? (
              <StudioEmptyGallery icon={Star} title="No favourite clips yet" message="Tap the star on a clip to keep it here." />
            ) : (
              <StudioEmptyGallery
                icon={Film}
                title="No videos yet"
                message="Clips you and your agents make will appear here, ready to play or download. Start with an idea:"
                suggestions={VIDEO_IDEA_STARTERS.map((idea) => ({
                  label: idea.label,
                  onPick: () => {
                    setPrompt(idea.prompt);
                    promptRef.current?.focus();
                  },
                }))}
                disabled={!configured}
              />
            )
          ) : (
            <section aria-label="Your videos" className={STUDIO_GALLERY_CLASS}>
              {videos.map((video) => (
                <StudioMediaCard
                  key={video.id}
                  data-testid="generated-video-card"
                  aspectRatio="16 / 9"
                  status={video.status === "completed" && video.contentPath ? "completed" : video.status === "pending" ? "pending" : "failed"}
                  pendingLabel={pendingLabel(video)}
                  media={
                    <video
                      src={video.contentPath ?? undefined}
                      poster={video.sourceImage?.contentPath ?? undefined}
                      controls
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-cover"
                      aria-label={`Video: ${video.prompt}`}
                    />
                  }
                  failure={{
                    message: "This clip could not be made. Try different words, or try again in a few minutes.",
                    detail: video.error,
                    onRetry: () => retry.mutate(video),
                    retrying: retry.isPending || !configured,
                  }}
                  badges={
                    video.favourite ? (
                      <span className="grid size-8 place-items-center rounded-full bg-background/80 text-primary shadow-sm" aria-hidden="true">
                        <Star className="h-4 w-4 fill-current" />
                      </span>
                    ) : null
                  }
                  actions={
                    <>
                      <StudioMediaAction
                        icon={Star}
                        label={video.favourite ? "Remove from favourites" : "Add to favourites"}
                        pressed={video.favourite}
                        onClick={() => favourite.mutate({ id: video.id, favourite: !video.favourite })}
                        iconClassName={video.favourite ? "fill-current text-primary" : undefined}
                        data-testid="video-favourite"
                      />
                      {video.assetId ? (
                        <StudioMediaAction
                          icon={Globe}
                          label="Use on website"
                          onClick={() => setWebsiteItem(studioClipItems([video])[0] ?? null)}
                          data-testid="video-card-use-on-website"
                        />
                      ) : null}
                      <StudioMediaAction
                        icon={Download}
                        label="Download"
                        href={video.contentPath ?? undefined}
                        download={downloadName(video)}
                        data-testid="video-card-download"
                      />
                    </>
                  }
                  caption={
                    <>
                      <p className="line-clamp-2 text-sm text-foreground" title={video.prompt}>
                        {video.prompt}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          video.sourceImage ? "From an image" : null,
                          videoModelLabel(video.model),
                          `${video.durationSeconds} seconds`,
                          videoMotionLabel(video.motion),
                          studioCameraLabel(video.camera),
                          relativeTime(video.createdAt),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <div className="flex gap-2 pt-1">
                        {video.status === "pending" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => cancel.mutate(video.id)}
                            disabled={cancel.isPending}
                            data-testid="video-cancel"
                          >
                            <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
                            Cancel
                          </Button>
                        ) : null}
                        {confirmDeleteId === video.id ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => remove.mutate(video.id)}
                            disabled={remove.isPending}
                            onBlur={() => setConfirmDeleteId(null)}
                          >
                            Delete for everyone
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeleteId(video.id)}
                            aria-label={`Delete video: ${video.prompt}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </>
                  }
                />
              ))}
            </section>
          )}
        </div>
      </div>
      <UseOnWebsiteDialog
        companyId={companyId}
        item={websiteItem}
        onClose={() => setWebsiteItem(null)}
        onSent={(message) => onSentToWebsite?.(message)}
      />
    </div>
  );
}
