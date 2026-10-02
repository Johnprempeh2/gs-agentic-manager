import { ArrowLeft, Archive, MoreVertical, Copy, SlidersHorizontal, EyeOff } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface InboxMobileToolbarProps {
  backHref: string;
  preferHistoryBack: boolean;
  issueId: string | undefined;
  issueHidden: boolean;
  onArchive: () => void;
  archivePending: boolean;
  onCopy: () => void;
  onProperties: () => void;
  onHide: () => void;
}

export function InboxMobileToolbar({
  backHref,
  preferHistoryBack,
  issueId: issueIdProp,
  issueHidden,
  onArchive,
  archivePending,
  onCopy,
  onProperties,
  onHide,
}: InboxMobileToolbarProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex items-center w-full">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          // Use browser back when we have real history so the inbox
          // restores its scroll position. Fall back to a PUSH to
          // backHref when there's no prior entry (e.g. deep-link).
          if (preferHistoryBack && window.history.length > 1) {
            navigate(-1);
          } else {
            navigate(backHref);
          }
        }}
        aria-label="Back to inbox"
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        {issueIdProp && !issueHidden && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onArchive}
            disabled={archivePending}
            aria-label="Archive from inbox"
          >
            <Archive className="h-5 w-5" />
          </Button>
        )}

        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => {
                onCopy();
                setMenuOpen(false);
              }}
            >
              <Copy className="h-3 w-3" />
              Copy as markdown
            </button>
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
              onClick={() => {
                onProperties();
                setMenuOpen(false);
              }}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Properties
            </button>
            {issueIdProp && (
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  onHide();
                  setMenuOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this task
              </button>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
