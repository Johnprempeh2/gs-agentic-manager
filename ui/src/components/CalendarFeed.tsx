import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { calendarApi } from "@/api/calendar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/clipboard";
import { relativeTime } from "@/lib/utils";
import { useConfirm } from "@/context/ConfirmContext";

export const calendarFeedKey = (companyId: string) => ["calendar-feed", companyId] as const;

/** One plain line on the feed for the Integrations card. */
export function calendarFeedStatusLine(status: { enabled: boolean; lastFetchedAt: string | null } | undefined) {
  if (!status?.enabled) return null;
  return status.lastFetchedAt
    ? `Your calendar app last checked for changes ${relativeTime(status.lastFetchedAt)}.`
    : "Turned on. No calendar app has subscribed yet.";
}

/**
 * Settings > Integrations: a private calendar address that Google Calendar,
 * Outlook or Apple Calendar subscribe to, showing task due dates and goal
 * dates. Off until a person turns it on. Needs no Google or Microsoft keys.
 */
export function CalendarFeedDialog({ companyId, open, onOpenChange }: { companyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: calendarFeedKey(companyId),
    queryFn: () => calendarApi.feedStatus(companyId),
    enabled: open,
  });
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: calendarFeedKey(companyId) });
  const enable = useMutation({
    mutationFn: () => calendarApi.enableFeed(companyId),
    onSuccess: (feed) => {
      setUrl(`${window.location.origin}${feed.path}`);
      setCopied(false);
      refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => calendarApi.disableFeed(companyId),
    onSuccess: () => {
      setUrl(null);
      refresh();
    },
  });
  const enabled = status.data?.enabled ?? false;
  const error = enable.error ?? disable.error ?? status.error;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setUrl(null); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deadlines in your calendar</DialogTitle>
          <DialogDescription>
            See task due dates and goal dates in Google Calendar, Outlook or Apple Calendar. Your calendar app checks for
            changes about once an hour. It is read-only: nothing is written to your calendar from here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {url ? (
            <>
              <div className="space-y-1">
                <Label htmlFor="calendar-feed-url">Your private calendar address</Label>
                <div className="flex gap-2">
                  <Input id="calendar-feed-url" readOnly value={url} className="font-mono text-xs" />
                  <Button type="button" size="sm" variant="outline" onClick={() => void copyTextToClipboard(url).then(() => setCopied(true))}>
                    <Copy />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Shown once. Anyone with this address can see your deadlines, so keep it private.
                </p>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>Google Calendar: Other calendars, then From URL, and paste the address.</li>
                <li>Outlook: Add calendar, then Subscribe from web, and paste the address.</li>
                <li>Apple Calendar: File, then New Calendar Subscription, and paste the address.</li>
              </ul>
            </>
          ) : enabled ? (
            <p className="text-muted-foreground">
              {calendarFeedStatusLine(status.data)} To see the address again, make a new one. The old address stops working.
            </p>
          ) : status.isLoading ? null : (
            <p className="text-muted-foreground">Turned off. Turn it on to get a private address for your calendar app.</p>
          )}
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">That did not work. Please try again in a moment. ({(error as Error).message})</p> : null}
        <DialogFooter className="gap-2">
          {enabled ? (
            <Button type="button" variant="ghost" disabled={disable.isPending} onClick={async () => {
              const ok = await confirm({
                title: "Turn off the calendar feed?",
                description: "Calendars that use it stop showing your deadlines. You can turn it back on later, with a new address.",
                confirmLabel: "Turn off",
              });
              if (ok) disable.mutate();
            }}>
              Turn off
            </Button>
          ) : null}
          <Button type="button" disabled={enable.isPending} onClick={async () => {
            if (enabled) {
              const ok = await confirm({
                title: "Make a new address?",
                description: "Calendars using the old address stop showing your deadlines until you add the new one.",
                confirmLabel: "Make a new address",
              });
              if (!ok) return;
            }
            enable.mutate();
          }}>
            {enabled ? "Make a new address" : "Turn on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
