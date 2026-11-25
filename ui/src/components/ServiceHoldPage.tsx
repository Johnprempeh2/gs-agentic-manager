import { PauseCircle, PowerOff } from "lucide-react";
import type { ServiceHoldStatus } from "@/api/health";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/utils";

/**
 * GSAM for Mac (P2). A stopped service (signed order from Greatstone) or an
 * ended subscription (the paid period is over) replaces the app with this
 * page. Agents do not start new work; nothing is deleted; the export page
 * stays open. A pause shows only the banner.
 */

export function isServiceStopped(service: ServiceHoldStatus) {
  return service.state === "stopped" || service.state === "ended";
}

function day(iso: string | null) {
  return iso ? formatCalendarDay(iso.slice(0, 10), { includeYear: true, longMonth: true }) : null;
}

export function ServiceHoldPage({ service, signedIn }: { service: ServiceHoldStatus; signedIn: boolean }) {
  const ended = service.state === "ended";
  const until = day(service.validUntil);
  return (
    <main className="mx-auto max-w-xl px-4 py-16" data-testid="service-hold-page">
      <Card className="block space-y-4 p-6">
        <PowerOff className="size-8 text-status-danger" aria-hidden />
        <h1 className="text-xl font-bold">{ended ? "Your GSAM subscription has ended" : "Service stopped by Greatstone"}</h1>
        <p className="text-sm">
          {ended
            ? `Your paid period ended${until ? ` on ${until}` : ""}. Your agents have stopped.`
            : "Greatstone has stopped the GSAM service on this Mac. Your agents have stopped."}
        </p>
        <p className="text-sm">
          Your data is safe. Nothing has been deleted: it stays on this Mac, and you can still export it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={service.renewUrl} target="_blank" rel="noreferrer">
              {ended ? "Renew your subscription" : "Contact Greatstone"}
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={signedIn ? "/company/export" : `/auth?next=${encodeURIComponent("/company/export")}`}>
              {signedIn ? "Export your data" : "Sign in to export your data"}
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {ended
            ? "When you renew, GSAM starts again within 5 minutes, with everything as you left it."
            : "When Greatstone resumes the service, GSAM starts again within 5 minutes."}
        </p>
      </Card>
    </main>
  );
}

/** Shown above the app: a pause, or the export page while the service is stopped. */
export function ServiceHoldBanner({ service }: { service: ServiceHoldStatus }) {
  if (service.state === "active") return null;
  const text =
    service.state === "paused"
      ? "Paused by Greatstone: your agents are not starting new work. Everything else works as usual."
      : service.state === "ended"
        ? "Your GSAM subscription has ended. You can export your data here."
        : "Service stopped by Greatstone. You can export your data here.";
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-chrome flex items-center justify-center gap-2 border-t border-status-warning/30 bg-status-warning-soft px-4 py-2 text-sm text-status-warning-foreground"
      data-testid="service-hold-banner"
    >
      <PauseCircle className="size-4 shrink-0" aria-hidden />
      {text}
    </div>
  );
}
