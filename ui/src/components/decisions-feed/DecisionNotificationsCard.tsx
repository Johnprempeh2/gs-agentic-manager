import { useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { useIsPhone } from "../../hooks/useIsPhone";

const DISMISS_KEY = "gsam.decision-notifications.dismissed";

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Turn phone notifications for decisions on or off (Web Push). Shown where
 * decisions are made. On iPhone it only works in the Home Screen app, so a
 * Safari tab gets that hint instead.
 */
export function DecisionNotificationsCard({ companyId }: { companyId: string | null | undefined }) {
  const { state, error, enable, disable, sendTest } = usePushNotifications(companyId);
  const isPhone = useIsPhone();
  const [dismissed, setDismissed] = useState(readDismissed);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // A private window keeps the choice for this visit only.
    }
  };

  if (state === "unsupported") return null;
  if (state === "needs-home-screen") {
    if (!isPhone || dismissed) return null;
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm" role="note">
        <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-muted-foreground">
          Add GS Agentic Manager to your Home Screen to get a notification when a decision needs you.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={dismiss}>OK</Button>
      </div>
    );
  }
  if (state === "on") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="decision-notifications-on">
        <Bell className="size-3.5 text-primary" aria-hidden />
        <span>Notifications are on for this device.</span>
        <Button type="button" size="xs" variant="ghost" onClick={() => void sendTest()}>Send a test</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => void disable()}>Turn off</Button>
        {error ? <span className="basis-full text-destructive" role="alert">{error}</span> : null}
      </div>
    );
  }
  if (state === "denied") {
    if (dismissed) return null;
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm" role="note">
        <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-muted-foreground">
          Notifications are blocked for this app. Turn them on in your phone's Settings, under Notifications.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={dismiss}>OK</Button>
      </div>
    );
  }
  if (dismissed && state !== "working") return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center" data-testid="decision-notifications-offer">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Bell className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-medium">Get a notification when a decision needs you</p>
          <p className="text-muted-foreground">Only decisions, nothing else.</p>
          {error ? <p className="text-destructive" role="alert">{error}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={dismiss} disabled={state === "working"}>Not now</Button>
        <Button type="button" size="sm" onClick={() => void enable()} disabled={state === "working"}>
          {state === "working" ? <Loader2 className="animate-spin" /> : null}
          Turn on
        </Button>
      </div>
    </div>
  );
}
