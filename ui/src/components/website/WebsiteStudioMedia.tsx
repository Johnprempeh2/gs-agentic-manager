import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Image as ImageIcon, Search } from "lucide-react";
import type { WebsiteMediaItem, WebsiteSite } from "@greatstone/shared";
import { imagesApi } from "../../api/images";
import { videosApi } from "../../api/videos";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import {
  CENTRE_FOCAL_POINT,
  STUDIO_MEDIA_SOURCE_LABEL,
  focalPointFromClick,
  hasAltText,
  mediaItemTitle,
  studioClipItems,
  studioImageItems,
  studioMediaEntry,
  type FocalPoint,
  type StudioMediaItem,
  type StudioMediaSource,
} from "../../lib/website-studio-media";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, errorStateMessage } from "../ErrorState";

// The website editor's "Add image" / "Add animation" picker and GS Studio's
// "Use on website" (GRE-2114). Both make a website media entry that points at
// the studio item's asset; alt text is required first. Words: GRE-2107 copy,
// section 7.

export type MediaPickerKind = "image" | "animation";

/** The media the picker used: a new entry made from a studio item, or an existing Website media entry. */
export interface PickedWebsiteMedia {
  assetId: string;
  contentPath: string;
  alt: string;
  /** True when the picker made a new media entry. */
  created: boolean;
}

const KIND_SOURCE: Record<MediaPickerKind, StudioMediaSource> = { image: "studio", animation: "animation" };

function useStudioMediaItems(companyId: string, source: StudioMediaSource, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.website.studioMedia(companyId, source),
    queryFn: async () =>
      source === "studio"
        ? studioImageItems((await imagesApi.list(companyId, { limit: 100 })).images)
        : studioClipItems((await videosApi.list(companyId, { limit: 100 })).videos),
    enabled,
  });
}

function useAddStudioMedia(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, item, alt, caption, focalPoint }: { siteId: string; item: StudioMediaItem; alt: string; caption: string; focalPoint: FocalPoint }) =>
      websiteModuleApi.createEntry(companyId, siteId, studioMediaEntry(item, { alt, caption, focalPoint })),
    onSuccess: (_entry, { siteId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.media(companyId, siteId) });
    },
  });
}

function StudioPreview({ item, className }: { item: StudioMediaItem; className?: string }) {
  return item.source === "animation" ? (
    <video src={item.contentPath} muted playsInline preload="metadata" aria-hidden="true" className={cn("size-full object-cover", className)} />
  ) : (
    <img src={item.contentPath} alt="" loading="lazy" className={cn("size-full object-cover", className)} />
  );
}

/**
 * One of the site's media entries, titled by its alt text. The key stays in
 * the tooltip. With `onSelect` the card is a toggle button (pick to use).
 */
export function WebsiteMediaCard({ item, selected, onSelect }: { item: WebsiteMediaItem; selected?: boolean; onSelect?: () => void }) {
  const hasAlt = hasAltText(item.alt);
  const body = (
    <>
      <span className="block aspect-video overflow-hidden rounded-md border border-border bg-muted">
        {item.contentType.startsWith("image/") ? (
          <img src={item.contentPath} alt={item.alt} loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground"><Film className="size-5" aria-hidden="true" /></span>
        )}
      </span>
      <span className="block truncate text-xs font-medium">{mediaItemTitle(item)}</span>
      {item.caption || !hasAlt ? (
        <span className="block truncate text-micro text-muted-foreground">{hasAlt ? item.caption : "No alt text"}</span>
      ) : null}
    </>
  );
  return (
    <li className="min-w-0" title={item.entryKey}>
      {onSelect ? (
        <button
          type="button"
          aria-pressed={Boolean(selected)}
          onClick={onSelect}
          className={cn(
            "block w-full space-y-1 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "bg-accent ring-2 ring-primary" : "hover:bg-accent/50",
          )}
          data-testid="media-picker-entry"
        >
          {body}
        </button>
      ) : (
        <div className="space-y-1">{body}</div>
      )}
    </li>
  );
}

/** Alt text (required), caption and, for images, the focus point. */
function MediaFields({
  item,
  alt,
  caption,
  focalPoint,
  altTouched,
  onAlt,
  onCaption,
  onFocalPoint,
}: {
  item: StudioMediaItem;
  alt: string;
  caption: string;
  focalPoint: FocalPoint;
  altTouched: boolean;
  onAlt: (value: string) => void;
  onCaption: (value: string) => void;
  onFocalPoint: (value: FocalPoint) => void;
}) {
  const id = useId();
  // Neutral until the person types and clears it; "Use" stays off either way.
  const missingAlt = altTouched && !hasAltText(alt);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {item.source === "studio" ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Focus point</p>
          <button
            type="button"
            aria-describedby={`${id}-focal-help`}
            onClick={(event) => {
              // A key press has no pointer position; keep the point it has.
              if (event.detail === 0) return;
              onFocalPoint(focalPointFromClick(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
            }}
            className="relative block aspect-video w-full overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="media-focal-point"
          >
            <StudioPreview item={item} />
            <span
              aria-hidden="true"
              className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-md"
              style={{ left: `${focalPoint.x * 100}%`, top: `${focalPoint.y * 100}%` }}
            />
          </button>
          <p id={`${id}-focal-help`} className="text-xs text-muted-foreground">
            Click the part of the image that must always show when it is cropped.
          </p>
        </div>
      ) : (
        <div className="aspect-video overflow-hidden rounded-md border border-border bg-muted">
          <StudioPreview item={item} />
        </div>
      )}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-alt`} className="text-sm font-medium">
            Alt text
          </label>
          <Input
            id={`${id}-alt`}
            value={alt}
            onChange={(event) => onAlt(event.target.value)}
            aria-required="true"
            aria-invalid={missingAlt || undefined}
            aria-describedby={`${id}-alt-help`}
            maxLength={300}
            data-testid="media-alt"
          />
          <p id={`${id}-alt-help`} className="text-xs text-muted-foreground">
            {missingAlt ? <span className="text-destructive">Add alt text before you use this. </span> : null}
            Describe what the image shows for people who cannot see it. Leave out "image of".
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-caption`} className="text-sm font-medium">
            Caption
          </label>
          <Input id={`${id}-caption`} value={caption} onChange={(event) => onCaption(event.target.value)} maxLength={300} />
        </div>
      </div>
    </div>
  );
}

function useMediaFields(item: StudioMediaItem | null) {
  const [alt, setAlt] = useState("");
  const [caption, setCaption] = useState("");
  const [focalPoint, setFocalPoint] = useState<FocalPoint>(CENTRE_FOCAL_POINT);
  const [altTouched, setAltTouched] = useState(false);
  useEffect(() => {
    setAlt("");
    setCaption("");
    setFocalPoint(CENTRE_FOCAL_POINT);
    setAltTouched(false);
  }, [item?.id]);
  const changeAlt = (value: string) => {
    setAlt(value);
    setAltTouched(true);
  };
  return { alt, setAlt: changeAlt, caption, setCaption, focalPoint, setFocalPoint, altTouched };
}

/** The editor's media picker: the site's own media, plus finished studio items. */
export function WebsiteMediaPicker({
  companyId,
  site,
  kind,
  media,
  canInsert = false,
  insertBlockName,
  onClose,
  onAdded,
}: {
  companyId: string;
  site: WebsiteSite;
  kind: MediaPickerKind | null;
  media: WebsiteMediaItem[];
  /** A block is selected in the editor, so an existing Website media entry can be used too. */
  canInsert?: boolean;
  /** The selected block's name, shown when `canInsert`. */
  insertBlockName?: string;
  onClose: () => void;
  onAdded: (message: string, media: PickedWebsiteMedia) => void;
}) {
  const source = KIND_SOURCE[kind ?? "image"];
  const [tab, setTab] = useState<"library" | "studio">("studio");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<StudioMediaItem | null>(null);
  const [pickedEntry, setPickedEntry] = useState<WebsiteMediaItem | null>(null);
  const fields = useMediaFields(picked);
  const studioQuery = useStudioMediaItems(companyId, source, kind !== null && tab === "studio");
  const add = useAddStudioMedia(companyId);

  useEffect(() => {
    setTab("studio");
    setQuery("");
    setPicked(null);
    setPickedEntry(null);
    add.reset();
    // Reset only when the picker opens for a kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const needle = query.trim().toLowerCase();
  const studioItems = (studioQuery.data ?? []).filter((item) => !needle || item.label.toLowerCase().includes(needle));
  const libraryItems = media
    .filter((item) => (kind === "animation" ? item.contentType.startsWith("video/") : item.contentType.startsWith("image/")))
    .filter((item) => !needle || `${item.alt} ${item.caption ?? ""} ${item.entryKey}`.toLowerCase().includes(needle));
  const canUse =
    tab === "studio"
      ? picked !== null && hasAltText(fields.alt) && !add.isPending
      : canInsert && pickedEntry !== null && hasAltText(pickedEntry.alt);
  const sourceLabel = STUDIO_MEDIA_SOURCE_LABEL[source];

  const use = () => {
    if (!canUse) return;
    if (tab === "library") {
      if (!pickedEntry) return;
      onAdded("", { assetId: pickedEntry.assetId, contentPath: pickedEntry.contentPath, alt: pickedEntry.alt, created: false });
      onClose();
      return;
    }
    if (!picked) return;
    const alt = fields.alt.trim();
    add.mutate(
      { siteId: site.id, item: picked, alt: fields.alt, caption: fields.caption, focalPoint: fields.focalPoint },
      {
        onSuccess: () => {
          onAdded(`Added from ${sourceLabel}. It is now in Website media and goes live with the next Publish.`, {
            assetId: picked.assetId,
            contentPath: picked.contentPath,
            alt,
            created: true,
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-h-(--sz-90vh) sm:max-w-3xl"
        scrollBody
        footer={
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            {tab === "studio" || canInsert ? (
              <Button type="button" disabled={!canUse} onClick={use} data-testid="media-use">
                {kind === "animation" ? <Film /> : <ImageIcon />}
                Use
              </Button>
            ) : null}
          </DialogFooter>
        }
        data-testid="website-media-picker"
      >
        <DialogHeader>
          <DialogTitle>{kind === "animation" ? "Add animation" : "Add image"}</DialogTitle>
          <DialogDescription className="sr-only">Pick an item, add alt text, then use it.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex rounded-md border border-border" role="tablist" aria-label="Source">
            {(["studio", "library"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => {
                  setTab(value);
                  setPicked(null);
                  setPickedEntry(null);
                }}
                className={cn(
                  "inline-flex h-8 items-center px-3 text-xs font-medium first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {value === "studio" ? sourceLabel : "Website media"}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 sm:flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="Find media" placeholder="Find media" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" />
          </div>
        </div>

        {tab === "library" ? (
          libraryItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No media yet. Images added as media entries show here.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {canInsert ? `Pick one to put in ${insertBlockName || "the selected block"}.` : "The site's images. The editor's image fields pick from these."}
              </p>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="media-picker-library">
                {libraryItems.map((item) =>
                  canInsert ? (
                    <WebsiteMediaCard
                      key={item.entryId}
                      item={item}
                      selected={pickedEntry?.entryId === item.entryId}
                      onSelect={() => setPickedEntry(item)}
                    />
                  ) : (
                    <WebsiteMediaCard key={item.entryId} item={item} />
                  ),
                )}
              </ul>
            </>
          )
        ) : studioQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading {sourceLabel}</p>
        ) : studioQuery.error ? (
          <ErrorState error={studioQuery.error} compact onRetry={() => void studioQuery.refetch()} />
        ) : studioItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {needle ? "Nothing matches. Try other words." : `Nothing finished in ${sourceLabel} yet.`}{" "}
            <Link to="/images" className="font-medium text-primary underline-offset-4 hover:underline">Open {sourceLabel}</Link>
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={sourceLabel} data-testid="media-picker-studio">
            {studioItems.map((item) => (
              <li key={item.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={picked?.id === item.id}
                  onClick={() => setPicked(item)}
                  title={item.label}
                  className={cn(
                    "block w-full space-y-1 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    picked?.id === item.id ? "bg-accent ring-2 ring-primary" : "hover:bg-accent/50",
                  )}
                  data-testid="media-picker-item"
                >
                  <span className="block aspect-video overflow-hidden rounded-sm border border-border bg-muted">
                    <StudioPreview item={item} />
                  </span>
                  <span className="line-clamp-2 text-xs text-foreground">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === "studio" && picked ? (
          <MediaFields
            item={picked}
            alt={fields.alt}
            caption={fields.caption}
            focalPoint={fields.focalPoint}
            altTouched={fields.altTouched}
            onAlt={fields.setAlt}
            onCaption={fields.setCaption}
            onFocalPoint={fields.setFocalPoint}
          />
        ) : null}
        {add.error ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(add.error)}</p> : null}

      </DialogContent>
    </Dialog>
  );
}

/** GS Studio's "Use on website": pick the site, add alt text, make the media entry. */
export function UseOnWebsiteDialog({
  companyId,
  item,
  onClose,
  onSent,
}: {
  companyId: string;
  item: StudioMediaItem | null;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const id = useId();
  const sitesQuery = useQuery({
    queryKey: queryKeys.website.sites(companyId),
    queryFn: () => websiteModuleApi.sites(companyId),
    enabled: item !== null,
  });
  const sites = useMemo(() => (sitesQuery.data ?? []).filter((site) => !site.archivedAt), [sitesQuery.data]);
  const [siteId, setSiteId] = useState("");
  const fields = useMediaFields(item);
  const add = useAddStudioMedia(companyId);
  const site = sites.find((entry) => entry.id === siteId) ?? (sites.length === 1 ? sites[0] : undefined);

  useEffect(() => {
    setSiteId("");
    add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const canSend = item !== null && site !== undefined && hasAltText(fields.alt) && !add.isPending;
  const send = () => {
    if (!item || !site || !canSend) return;
    add.mutate(
      { siteId: site.id, item, alt: fields.alt, caption: fields.caption, focalPoint: fields.focalPoint },
      {
        onSuccess: () => {
          onSent(`Sent to ${site.name}'s Website media.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-h-(--sz-90vh) sm:max-w-2xl"
        scrollBody
        footer={
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={!canSend} onClick={send} data-testid="use-on-website-send">
              Use on website
            </Button>
          </DialogFooter>
        }
        data-testid="use-on-website"
      >
        <DialogHeader>
          <DialogTitle>Use on website</DialogTitle>
          <DialogDescription className="line-clamp-2">{item?.label}</DialogDescription>
        </DialogHeader>
        {sitesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading sites</p>
        ) : sitesQuery.error ? (
          <ErrorState error={sitesQuery.error} compact onRetry={() => void sitesQuery.refetch()} />
        ) : sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No site is connected yet.{" "}
            <Link to="/website" className="font-medium text-primary underline-offset-4 hover:underline">Open Website</Link>
          </p>
        ) : (
          <>
            {sites.length > 1 ? (
              <div className="space-y-1.5">
                <label htmlFor={`${id}-site`} className="text-sm font-medium">Which site?</label>
                <NativeSelect id={`${id}-site`} value={siteId} onChange={(event) => setSiteId(event.target.value)} data-testid="use-on-website-site">
                  <option value="" disabled>Which site?</option>
                  {sites.map((entry) => (
                    <option key={entry.id} value={entry.id}>{`${entry.name} (${entry.domain})`}</option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {item ? (
              <MediaFields
                item={item}
                alt={fields.alt}
                caption={fields.caption}
                focalPoint={fields.focalPoint}
                altTouched={fields.altTouched}
                onAlt={fields.setAlt}
                onCaption={fields.setCaption}
                onFocalPoint={fields.setFocalPoint}
              />
            ) : null}
          </>
        )}
        {add.error ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(add.error)}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
