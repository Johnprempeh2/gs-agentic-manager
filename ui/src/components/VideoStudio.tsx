import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_VIDEO_PROMPT_MAX_LENGTH,
  GENERATED_VIDEO_PROMPT_MIN_LENGTH,
  hasStudioCamera,
  studioCameraLabel,
  VIDEO_MODELS,
  VIDEO_MOTION_PRESETS,
  videoModel,
  videoModelLabel,
  videoMotionLabel,
  type GeneratedImage,
  type GeneratedVideo,
  type StudioCameraSettings,
  type VideoModelId,
  type VideoMotionPresetId,
} from "@greatstone/shared";
import { AlertCircle, Clapperboard, Download, Film, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { videosApi } from "../api/videos";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "./EmptyState";
import { StudioCameraFields } from "./StudioCameraFields";
import { StudioLookPicker } from "./StudioLookPicker";
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

interface VideoStudioProps {
  companyId: string;
  /** A finished studio image to animate, picked from the image gallery. */
  sourceImage: GeneratedImage | null;
  onClearSourceImage: () => void;
  onError: (message: string) => void;
  onDeleted?: () => void;
}

/**
 * The studio's moving-picture side: a short clip from a description, or a
 * finished image brought to life. Clips take a few minutes, so the list keeps
 * checking while any is still being made.
 */
export function VideoStudio({ companyId, sourceImage, onClearSourceImage, onError, onDeleted }: VideoStudioProps) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<VideoModelId>("kling-2.5-turbo-pro");
  const [duration, setDuration] = useState<number | null>(null);
  const [motion, setMotion] = useState<VideoMotionPresetId | null>(null);
  const [camera, setCamera] = useState<StudioCameraSettings>({});
  const [lookId, setLookId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.videos.status(companyId),
    queryFn: () => videosApi.status(companyId),
  });
  const listQuery = useQuery({
    queryKey: queryKeys.videos.list(companyId),
    queryFn: () => videosApi.list(companyId, { limit: 60 }),
    refetchInterval: (query) => (query.state.data?.videos.some((video) => video.status === "pending") ? 5_000 : false),
  });

  const model = videoModel(modelId)!;
  // A model that only animates images cannot be used without one.
  const usableModels = VIDEO_MODELS.filter((item) => sourceImage || item.textPath);
  const effectiveModel = usableModels.some((item) => item.id === modelId) ? model : videoModel(usableModels[0]!.id)!;
  const effectiveDuration = duration && (effectiveModel.durations as readonly number[]).includes(duration) ? duration : effectiveModel.durations[0];

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
      }),
    onSuccess: () => {
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) });
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
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.videos.list(companyId) }),
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

  const configured = statusQuery.data?.configured === true;
  const canSubmit = configured && prompt.trim().length >= GENERATED_VIDEO_PROMPT_MIN_LENGTH && !create.isPending;
  const videos = listQuery.data?.videos ?? [];

  return (
    <div className="space-y-6">
      <section className="gs-glass-card space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="video-composer-title">
        <div className="flex items-center gap-2">
          <Clapperboard className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 id="video-composer-title" className="text-sm font-semibold">
            {sourceImage ? "Bring an image to life" : "Make a video"}
          </h2>
          {statusQuery.data?.providerLabel ? (
            <span className="ml-auto text-xs text-muted-foreground">Using {statusQuery.data.providerLabel}</span>
          ) : null}
        </div>

        {!configured && statusQuery.isSuccess ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm" data-testid="videos-not-set-up">
            <p className="font-medium text-foreground">Video making is not switched on yet</p>
            <p className="mt-1 text-muted-foreground">
              It uses the same Higgsfield key as images. Once whoever runs GSAM adds it, you and your agents can make clips here.
            </p>
          </div>
        ) : null}

        {sourceImage ? (
          <div className="flex items-center gap-3 rounded-md border border-border p-2" data-testid="video-source-image">
            {sourceImage.contentPath ? (
              <img src={sourceImage.contentPath} alt={sourceImage.altText} className="h-16 w-24 shrink-0 rounded object-cover" />
            ) : null}
            <p className="min-w-0 flex-1 truncate text-sm">{sourceImage.prompt}</p>
            <Button variant="ghost" size="sm" onClick={onClearSourceImage} aria-label="Stop using this image">
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        <div className="space-y-2">
          <label htmlFor="video-prompt" className="text-sm font-medium">
            {sourceImage ? "What should happen in the picture?" : "What should the clip show?"}
          </label>
          <Textarea
            id="video-prompt"
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
                ? "For example: the steam rises from the coffee and the light shifts gently"
                : "For example: a red double-decker bus crossing Westminster Bridge at dusk, light rain"
            }
            maxLength={GENERATED_VIDEO_PROMPT_MAX_LENGTH}
            rows={3}
            disabled={!configured}
            data-testid="video-prompt"
          />
        </div>

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
                    "rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    selected ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:bg-accent/40",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <StudioLookPicker
          companyId={companyId}
          idPrefix="video"
          lookId={lookId}
          onPick={(look) => {
            setLookId(look?.id ?? null);
            setCamera(look?.camera ?? {});
          }}
          current={{ camera }}
          disabled={!configured}
        />
        <StudioCameraFields idPrefix="video" camera={camera} onCameraChange={setCamera} disabled={!configured} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium" htmlFor="video-model">
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
          <fieldset className="space-y-1" disabled={!configured}>
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
                    "rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60",
                    effectiveDuration === seconds ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border hover:bg-accent/40",
                  )}
                >
                  {seconds} seconds
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Clips usually take a few minutes. You can leave this page; it keeps going.</p>
          <Button onClick={() => create.mutate()} disabled={!canSubmit} data-testid="make-video">
            {create.isPending ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Film className="h-4 w-4" aria-hidden="true" />
            )}
            {sourceImage ? "Animate image" : "Make video"}
          </Button>
        </div>
      </section>

      {videos.length === 0 ? (
        <EmptyState icon={Film} title="No videos yet" message="Clips you and your agents make will appear here, ready to play or download." />
      ) : (
        <section aria-label="Your videos" className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((video) => (
            <figure key={video.id} className="gs-glass-card flex flex-col overflow-hidden rounded-lg border bg-card" data-testid="generated-video-card">
              <div className="relative aspect-video w-full overflow-hidden bg-muted">
                {video.status === "completed" && video.contentPath ? (
                  <video
                    src={video.contentPath}
                    poster={video.sourceImage?.contentPath ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                    aria-label={`Video: ${video.prompt}`}
                  />
                ) : video.status === "pending" ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground motion-safe:animate-pulse" role="status">
                    <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden="true" />
                    <span className="text-xs">Making your video...</span>
                  </div>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
                    <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
                    {video.error ? <p className="line-clamp-2 text-xs text-muted-foreground" title={video.error}>{video.error}</p> : null}
                    <Button size="sm" variant="outline" onClick={() => retry.mutate(video)} disabled={retry.isPending || !configured}>
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      Try again
                    </Button>
                  </div>
                )}
              </div>
              <figcaption className="space-y-1 p-3">
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
                  {video.contentPath ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={video.contentPath} download={downloadName(video)}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Download
                      </a>
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
              </figcaption>
            </figure>
          ))}
        </section>
      )}
    </div>
  );
}
