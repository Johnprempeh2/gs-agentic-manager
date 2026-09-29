import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ReleaseChangelog } from "./ReleaseChangelog";
import { useCanRelease, useClientVersion, useReleases } from "@/hooks/useReleases";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { formatDate } from "@/lib/utils";

const FOOTER_BUTTON_CLASS =
  "flex w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Sidebar footer line naming the running version; a click opens "What's new".
 * Our own install: the live version and its changelog, board only, like the
 * Releases page. Client editions (Releases hidden, GRE-129): "Version X" and
 * the client notes of the stable tag it runs, for everyone (GRE-128). Hidden
 * in the rail.
 */
export function SidebarReleaseFooter({ companyId, rail = false }: { companyId: string | null; rail?: boolean }) {
  const { hidden, loaded } = useHiddenSettings();
  if (rail || !loaded) return null;
  return hidden.has("instance.releases") ? (
    <ClientVersionFooter companyId={companyId} />
  ) : (
    <AdminReleaseFooter companyId={companyId} />
  );
}

/** Client notes only: never live-* changelogs, pull request or GRE numbers. */
function ClientVersionFooter({ companyId }: { companyId: string | null }) {
  const { data } = useClientVersion(companyId);
  const [open, setOpen] = useState(false);

  if (!data?.label) return null;
  const title = `Version ${data.label}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={FOOTER_BUTTON_CLASS}
        data-slot="sidebar-release-footer"
        aria-label={`What's new in ${title}`}
      >
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>What's new in {title}</DialogTitle>
            <DialogDescription>The version this workspace runs.</DialogDescription>
          </DialogHeader>
          {data.notes ? (
            <p className="whitespace-pre-line break-words text-sm" data-slot="client-notes">
              {data.notes}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No notes for this version.</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AdminReleaseFooter({ companyId }: { companyId: string | null }) {
  const { canRelease } = useCanRelease(companyId);
  const { data } = useReleases(companyId, { enabled: canRelease });
  const [open, setOpen] = useState(false);
  const live = data?.live;

  if (!canRelease || !live) return null;
  const title = live.title ?? live.tag ?? live.commit.slice(0, 7);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={FOOTER_BUTTON_CLASS}
        data-slot="sidebar-release-footer"
        aria-label={`What's new in ${title}`}
      >
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>What's new in {title}</DialogTitle>
            <DialogDescription>
              {live.tag ? <span className="font-mono text-xs">{live.tag}</span> : null}
              {live.tag && live.date ? " · " : null}
              {live.date ? `live since ${formatDate(live.date)}` : null}
            </DialogDescription>
          </DialogHeader>
          <ReleaseChangelog changelog={live.changelog} />
          <DialogFooter>
            <Button variant="outline" asChild>
              <Link to="/releases" onClick={() => setOpen(false)}>
                All releases
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
