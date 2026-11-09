import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Pencil, Trash2 } from "lucide-react";
import type { WebsiteMediaItem } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { formatBytes } from "../../lib/issue-output";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmButton } from "@/components/commerce/CommerceWriteParts";
import { ErrorState, errorStateMessage } from "../ErrorState";

// Website media (GRE-4785, GRE-4079 step 5d): rename and delete. Rename changes only the name; pages point at the
// file. Delete takes it off the site at the next Publish and is refused while a page still uses it. Media is added
// from the page editor or GS Studio.

function RenameDialog({ companyId, siteId, item, onClose, onRenamed }: {
  companyId: string;
  siteId: string;
  item: WebsiteMediaItem;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(item.entryKey);
  const rename = useMutation({
    mutationFn: () => websiteModuleApi.renameMedia(companyId, siteId, item.entryId, name.trim()),
    onSuccess: (renamed) => {
      onRenamed(renamed.entryKey);
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) rename.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md" data-testid="website-media-rename">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename media</DialogTitle>
            <DialogDescription>Only the name changes. The file, its alt text and the pages that use it stay as they are.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">Name</label>
            <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} data-testid="media-name" />
          </div>
          {rename.error ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(rename.error)}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={rename.isPending || !name.trim() || name.trim() === item.entryKey} data-testid="media-rename-save">
              {rename.isPending ? "Saving" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WebsiteMediaLibrary({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const media = useQuery({ queryKey: queryKeys.website.media(companyId, siteId), queryFn: () => websiteModuleApi.media(companyId, siteId) });
  const access = useQuery({
    queryKey: queryKeys.website.access(companyId, siteId),
    queryFn: () => websiteModuleApi.access(companyId, siteId),
    retry: false,
  });
  const canEdit = access.data?.edit ?? false;
  const [renaming, setRenaming] = useState<WebsiteMediaItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.website.media(companyId, siteId) });
  const remove = useMutation({
    mutationFn: (item: WebsiteMediaItem) => websiteModuleApi.deleteMedia(companyId, siteId, item.entryId),
    onSuccess: (_result, item) => {
      setMessage(`Deleted ${item.entryKey}. It leaves the site when you Publish. The file stays in your company's files.`);
      refresh();
    },
  });

  const items = media.data ?? [];
  return (
    <section className="space-y-4" data-testid="website-media-library">
      <div>
        <h3 className="text-base font-semibold">Media</h3>
        <p className="text-sm text-muted-foreground">
          The site's images and animations. Add new ones from the page editor or GS Studio. A deleted item leaves the site when you Publish.
        </p>
      </div>
      {message ? <p role="status" className="text-sm text-status-success">{message}</p> : null}
      {remove.error ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(remove.error)}</p> : null}
      {media.error ? (
        <ErrorState error={media.error} onRetry={() => void media.refetch()} />
      ) : media.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading media</p>
      ) : items.length === 0 ? (
        <div className="space-y-1 rounded-lg border border-dashed border-border p-6 text-center">
          <h4 className="font-medium">No media yet</h4>
          <p className="text-sm text-muted-foreground">Add an image from the page editor, or use Use on website in GS Studio.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Media">
          {items.map((item) => (
            <li key={item.entryId} className="min-w-0 space-y-2 rounded-lg border border-border p-2" data-testid="media-library-item">
              <span className="block aspect-video overflow-hidden rounded-md border border-border bg-muted">
                {item.contentType.startsWith("image/") ? (
                  <img src={item.contentPath} alt={item.alt} loading="lazy" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-muted-foreground"><Film className="size-5" aria-hidden="true" /></span>
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={item.entryKey}>{item.entryKey}</p>
                <p className="truncate text-xs text-muted-foreground" title={item.alt}>{item.alt || "No alt text"}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(item.byteSize)}</p>
              </div>
              {canEdit ? (
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => { setMessage(null); setRenaming(item); }} aria-label={`Rename ${item.entryKey}`}>
                    <Pencil />
                    Rename
                  </Button>
                  <ConfirmButton
                    label={<Trash2 />}
                    ariaLabel={`Delete ${item.entryKey}`}
                    variant="ghost"
                    destructive
                    title="Delete this media?"
                    description={`${item.entryKey} leaves the site when you next Publish. The file stays in your company's files. If a page still uses it, GSAM says which one and keeps it.`}
                    confirmLabel="Delete"
                    disabled={remove.isPending}
                    onConfirm={() => { setMessage(null); remove.mutate(item); }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {renaming ? (
        <RenameDialog
          companyId={companyId}
          siteId={siteId}
          item={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(name) => { setMessage(`Renamed to ${name}.`); refresh(); }}
        />
      ) : null}
    </section>
  );
}
