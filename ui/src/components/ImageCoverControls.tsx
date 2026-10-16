import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GeneratedImage, GeneratedImageCovers, UpdateGeneratedImageCover } from "@greatstone/shared";
import { Check, ImageIcon } from "lucide-react";
import { imagesApi } from "../api/images";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/**
 * "Use as cover" for a finished image: shows it on the card of the task or
 * client it was made for. A task or client has one cover, so picking a new
 * one replaces the last.
 */
export function ImageCoverControls({ image }: { image: GeneratedImage }) {
  const queryClient = useQueryClient();
  const setCover = useMutation({
    mutationFn: (patch: UpdateGeneratedImageCover) => imagesApi.setCover(image.id, patch),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.images.detail(updated.id), updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.images.all(image.companyId) });
    },
  });

  if (image.status !== "completed" || (!image.issue && !image.organisation)) return null;

  const options = [
    image.issue
      ? {
          key: "issueCover" as const,
          on: image.issueCover,
          label: image.issueCover ? `Cover of ${image.issue.identifier ?? "the task"}` : `Use as cover for ${image.issue.identifier ?? "the task"}`,
        }
      : null,
    image.organisation
      ? {
          key: "organisationCover" as const,
          on: image.organisationCover,
          label: image.organisationCover ? `Cover of ${image.organisation.name}` : `Use as cover for ${image.organisation.name}`,
        }
      : null,
  ].filter((option): option is NonNullable<typeof option> => option !== null);

  return (
    <div className="space-y-1" data-testid="image-cover-controls">
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.key}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={option.on}
            disabled={setCover.isPending}
            onClick={() => setCover.mutate({ [option.key]: !option.on })}
            className={cn(option.on && "border-primary ring-1 ring-primary")}
          >
            {option.on ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />}
            {option.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {setCover.error ? errorMessage(setCover.error) : "A cover shows on the card in boards and lists. Press again to remove it."}
      </p>
    </div>
  );
}

/** Covers for the company's task and client cards, fetched once and shared. */
export function useImageCovers(companyId: string | null | undefined) {
  return useQuery<GeneratedImageCovers>({
    queryKey: queryKeys.images.covers(companyId ?? ""),
    queryFn: () => imagesApi.covers(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });
}

export type CardCoverImage = { contentPath: string; altText: string };

/** A short banner picture at the top of a card. Decorative, as the card says what it is. */
export function CardCover({ cover }: { cover: CardCoverImage | undefined }) {
  if (!cover) return null;
  return (
    <img
      src={cover.contentPath}
      alt=""
      title={cover.altText}
      loading="lazy"
      className="mb-2 block aspect-video w-full rounded-sm object-cover"
      data-testid="card-cover"
    />
  );
}
