import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImagePlus, Images, Link2, Sparkles, X } from "lucide-react";
import { imagesApi } from "../../api/images";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { studioImageItems } from "../../lib/website-studio-media";
import { IMAGE_ACCEPT, MAX_ATTACHMENTS, NOTE_MAX, normaliseLink, type DraftAttachment, type NewDraftAttachment } from "../../lib/website-change-attachments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorStateMessage } from "../ErrorState";

// Ask an agent, slice 2 (GRE-2527): the attachments under "What should
// change?". Upload or paste images, pick one from Website media or GS Studio,
// add a reference site or an effect from the site's effects library. Each one
// takes an optional one-line note. Nothing here uploads or publishes: the
// panel attaches the files when the person sends.

/** An effect from the site's effects library, as the site's editor sent it. */
export interface WebsiteChangeEffect {
  id: string;
  label: string;
  description?: string;
}

type Adding = "media" | "link" | "effect" | null;

const KIND_NAMES: Record<DraftAttachment["kind"], string> = {
  upload: "Image",
  media: "Image",
  link: "Reference site",
  effect: "Effect",
};

function draftTitle(draft: DraftAttachment) {
  switch (draft.kind) {
    case "upload":
      return draft.file.name;
    case "media":
      return draft.label || (draft.source === "studio" ? "GS Studio image" : "Website media image");
    case "link":
      return draft.url.replace(/^https?:\/\//, "");
    case "effect":
      return draft.label || draft.effectId;
  }
}

function draftSource(draft: DraftAttachment) {
  if (draft.kind === "upload") return "Uploaded";
  if (draft.kind === "media") return draft.source === "studio" ? "GS Studio" : "Website media";
  return KIND_NAMES[draft.kind];
}

function DraftThumb({ draft }: { draft: DraftAttachment }) {
  const src = draft.kind === "upload" ? draft.previewUrl : draft.kind === "media" ? draft.contentPath : "";
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted text-muted-foreground">
      {src ? (
        <img src={src} alt="" className="size-full object-cover" />
      ) : draft.kind === "link" ? (
        <Link2 className="size-4" aria-hidden="true" />
      ) : (
        <Sparkles className="size-4" aria-hidden="true" />
      )}
    </span>
  );
}

/** Website media and GS Studio images to pick from. Picking one adds it; nothing new is made. */
function MediaChoices({
  companyId,
  siteId,
  onPick,
}: {
  companyId: string;
  siteId: string;
  onPick: (pick: { source: "website" | "studio"; assetId: string; label: string; contentPath: string }) => void;
}) {
  const [tab, setTab] = useState<"website" | "studio">("website");
  const media = useQuery({
    queryKey: queryKeys.website.media(companyId, siteId),
    queryFn: () => websiteModuleApi.media(companyId, siteId),
    enabled: tab === "website",
  });
  const studio = useQuery({
    queryKey: queryKeys.website.studioMedia(companyId, "studio"),
    queryFn: async () => studioImageItems((await imagesApi.list(companyId, { limit: 100 })).images),
    enabled: tab === "studio",
  });
  const query = tab === "website" ? media : studio;
  const items =
    tab === "website"
      ? (media.data ?? [])
          .filter((item) => item.contentType.startsWith("image/") && item.contentType !== "image/svg+xml")
          .map((item) => ({ key: item.entryId, assetId: item.assetId, label: item.alt || item.entryKey, contentPath: item.contentPath }))
      : (studio.data ?? []).map((item) => ({ key: item.id, assetId: item.assetId, label: item.label, contentPath: item.contentPath }));

  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="website-change-media-choices">
      <div role="tablist" aria-label="Where the image is" className="flex gap-1">
        {(["website", "studio"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? "secondary" : "ghost"}
            onClick={() => setTab(value)}
          >
            {value === "website" ? "Website media" : "GS Studio"}
          </Button>
        ))}
      </div>
      {query.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading images…</p>
      ) : query.error ? (
        <p role="alert" className="text-xs text-status-danger-foreground">
          The images did not load: {errorStateMessage(query.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {tab === "website" ? "This site has no images in Website media yet." : "No finished GS Studio images yet."}
        </p>
      ) : (
        // Two columns at every width: the drawer is narrow even on a laptop, so names stay readable.
        <ul className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto">
          {items.map((item) => (
            <li key={item.key} className="min-w-0">
              <button
                type="button"
                title={item.label}
                className="block w-full space-y-1 rounded-md p-1 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onPick({ source: tab, assetId: item.assetId, label: item.label.slice(0, 200), contentPath: item.contentPath })}
                data-testid="website-change-media-item"
              >
                <span className="block aspect-video overflow-hidden rounded border border-border bg-muted">
                  <img src={item.contentPath} alt="" loading="lazy" className="size-full object-cover" />
                </span>
                <span className="line-clamp-2 break-words text-micro">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WebsiteChangeAttachments({
  companyId,
  siteId,
  drafts,
  effects,
  problem,
  disabled = false,
  onAddFiles,
  onAdd,
  onNote,
  onRemove,
}: {
  companyId: string;
  siteId: string;
  drafts: DraftAttachment[];
  /** The site's effects library; empty when the site's editor did not send one. */
  effects: readonly WebsiteChangeEffect[];
  /** Why the last add did not work, shown until the next one. */
  problem: string | null;
  disabled?: boolean;
  onAddFiles: (files: File[]) => void;
  onAdd: (draft: NewDraftAttachment) => void;
  onNote: (key: string, note: string) => void;
  onRemove: (key: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const [link, setLink] = useState("");
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const full = drafts.length >= MAX_ATTACHMENTS;
  const toggle = (next: Adding) => setAdding((open) => (open === next ? null : next));

  const addLink = () => {
    const url = normaliseLink(link);
    if (!url) {
      setLinkProblem("Type a web address, for example example.com/page.");
      return;
    }
    onAdd({ kind: "link", url });
    setLink("");
    setLinkProblem(null);
    setAdding(null);
  };

  return (
    <div className="space-y-2" data-testid="website-change-attachments">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-medium">Show what you mean</span>
        <Button type="button" size="sm" variant="outline" disabled={disabled || full} onClick={() => fileRef.current?.click()}>
          <ImagePlus />
          Image
        </Button>
        <Button type="button" size="sm" variant="outline" aria-expanded={adding === "media"} disabled={disabled || full} onClick={() => toggle("media")}>
          <Images />
          From media
        </Button>
        <Button type="button" size="sm" variant="outline" aria-expanded={adding === "link"} disabled={disabled || full} onClick={() => toggle("link")}>
          <Link2 />
          Link
        </Button>
        {effects.length > 0 ? (
          <Button type="button" size="sm" variant="outline" aria-expanded={adding === "effect"} disabled={disabled || full} onClick={() => toggle("effect")}>
            <Sparkles />
            Effect
          </Button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          data-testid="website-change-file"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) onAddFiles(files);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {full
          ? `That is the most one request takes (${MAX_ATTACHMENTS}).`
          : "Paste or add images (PNG, JPEG, WebP or GIF, up to 8 MB), a reference site or an effect. Each can have a note."}
      </p>
      {problem ? (
        <p role="alert" className="text-xs text-status-danger-foreground" data-testid="website-change-attach-problem">
          {problem}
        </p>
      ) : null}

      {adding === "media" && !full ? (
        <MediaChoices
          companyId={companyId}
          siteId={siteId}
          onPick={(pick) => {
            onAdd({ kind: "media", ...pick });
            setAdding(null);
          }}
        />
      ) : null}
      {adding === "link" && !full ? (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <Input
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setLinkProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLink();
                }
              }}
              type="url"
              inputMode="url"
              maxLength={2000}
              placeholder="example.com/page you like"
              aria-label="Reference site address"
              aria-invalid={linkProblem ? true : undefined}
              autoFocus
            />
            <Button type="button" size="sm" onClick={addLink}>
              Add
            </Button>
          </div>
          {linkProblem ? <p role="alert" className="text-xs text-status-danger-foreground">{linkProblem}</p> : null}
        </div>
      ) : null}
      {adding === "effect" && !full ? (
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1" data-testid="website-change-effects">
          {effects.map((effect) => (
            <li key={effect.id}>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onAdd({ kind: "effect", effectId: effect.id, label: effect.label });
                  setAdding(null);
                }}
              >
                <span className="block text-sm">{effect.label}</span>
                {effect.description ? <span className="block truncate text-xs text-muted-foreground">{effect.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {drafts.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Attached">
          {drafts.map((draft) => {
            const title = draftTitle(draft);
            // The note takes the full row, so its hint fits in the narrow drawer and on a phone (GRE-2759).
            return (
              <li
                key={draft.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 rounded-md border border-border p-1.5"
                data-testid="website-change-attachment"
                data-kind={draft.kind}
              >
                <DraftThumb draft={draft} />
                <p className="truncate text-xs">
                  <span className="text-muted-foreground">{draftSource(draft)} · </span>
                  <span className="font-medium" title={title}>{title}</span>
                </p>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${title}`} disabled={disabled} onClick={() => onRemove(draft.key)}>
                  <X />
                </Button>
                <Input
                  value={draft.note}
                  onChange={(event) => onNote(draft.key, event.target.value.replace(/[\r\n]+/g, " "))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !(event.metaKey || event.ctrlKey)) event.preventDefault();
                  }}
                  maxLength={NOTE_MAX}
                  placeholder="Note (optional), e.g. this colour"
                  aria-label={`Note for ${title}`}
                  className="col-span-3 h-8"
                  disabled={disabled}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
