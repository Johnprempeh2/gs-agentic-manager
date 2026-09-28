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
import { useCanRelease, useReleases } from "@/hooks/useReleases";
import { formatDate } from "@/lib/utils";

/**
 * Sidebar footer line naming the live version; a click opens its changelog
 * ("What's new"). Board only, like the Releases page. Hidden in the rail.
 */
export function SidebarReleaseFooter({ companyId, rail = false }: { companyId: string | null; rail?: boolean }) {
  const { canRelease } = useCanRelease(companyId);
  const { data } = useReleases(companyId, { enabled: canRelease });
  const [open, setOpen] = useState(false);
  const live = data?.live;

  if (rail || !canRelease || !live) return null;
  const title = live.title ?? live.tag ?? live.commit.slice(0, 7);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
