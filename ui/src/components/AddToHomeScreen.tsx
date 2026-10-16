import { useEffect, useState } from "react";
import { Bell, Maximize2, Plus, Share, Smartphone, X } from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { isChromelessDisplayMode } from "../lib/pwa-display-mode";

const DISMISSED_AT_KEY = "gsam.add-to-home-screen.dismissed-at";
/** "Not now" hides the offer for two weeks. */
export const ADD_TO_HOME_SCREEN_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** Chrome's install event; not in the DOM typings. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isIphoneSafari(userAgent: string) {
  // Other iPhone browsers (Chrome, Firefox, Edge) cannot add to the Home Screen in every version.
  return /iPhone|iPod/.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

function snoozed(now: number) {
  try {
    const at = Number(window.localStorage.getItem(DISMISSED_AT_KEY));
    return Number.isFinite(at) && at > 0 && now - at < ADD_TO_HOME_SCREEN_SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(now: number) {
  try {
    window.localStorage.setItem(DISMISSED_AT_KEY, String(now));
  } catch {
    // A private window keeps the choice for this visit only.
  }
}

function IphoneSteps() {
  const steps = [
    { icon: Share, text: "Tap the Share button at the bottom of Safari." },
    { icon: Plus, text: "Scroll down and tap Add to Home Screen, then Add." },
    { icon: Smartphone, text: "Open GSAM from the new icon on your Home Screen." },
  ];
  return (
    <ol className="space-y-3">
      {steps.map(({ icon: Icon, text }, index) => (
        <li key={text} className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
            {index + 1}
          </span>
          <span className="flex min-w-0 items-start gap-2 pt-1 text-sm">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            {text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A friendly offer to put GSAM on the phone's Home Screen. Android (Chrome)
 * gets its own install prompt; iPhone Safari has none, so it gets a one screen
 * walkthrough. Hidden once installed, on browsers that cannot install, and for
 * two weeks after "Not now".
 */
export function AddToHomeScreen({ now = () => Date.now() }: { now?: () => number }) {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() => isChromelessDisplayMode() || snoozed(now()));
  const [showSteps, setShowSteps] = useState(false);
  const iphone = typeof navigator !== "undefined" && isIphoneSafari(navigator.userAgent);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden || (!iphone && !installEvent)) return null;

  const dismiss = () => {
    snooze(now());
    setHidden(true);
  };

  const add = async () => {
    if (!installEvent) {
      setShowSteps(true);
      return;
    }
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    setInstallEvent(null);
    if (outcome === "accepted") setHidden(true);
  };

  return (
    <>
      <section
        className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-card p-3"
        aria-labelledby="add-to-home-screen-title"
      >
        <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h2 id="add-to-home-screen-title" className="text-sm font-semibold">Put GSAM on your Home Screen</h2>
            <p className="text-sm text-muted-foreground">It opens like an app and can tell you when something needs you.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void add()}>
              {installEvent ? "Add to Home Screen" : "Show me how"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
          </div>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={dismiss}>
          <X aria-hidden />
        </Button>
      </section>

      <Sheet open={showSteps} onOpenChange={setShowSteps}>
        <SheetContent side="bottom" className="space-y-5 rounded-t-xl p-5 pb-8">
          <SheetHeader className="p-0">
            <SheetTitle>Add GSAM to your Home Screen</SheetTitle>
            <SheetDescription>Three taps in Safari. You only do this once.</SheetDescription>
          </SheetHeader>
          <IphoneSteps />
          <ul className="space-y-2 rounded-lg bg-muted p-3 text-sm">
            <li className="flex items-start gap-2">
              <Maximize2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              Opens full screen, like any other app.
            </li>
            <li className="flex items-start gap-2">
              <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              On iPhone, notifications only work from the Home Screen app.
            </li>
          </ul>
          <Button type="button" className="w-full" onClick={() => setShowSteps(false)}>Got it</Button>
        </SheetContent>
      </Sheet>
    </>
  );
}
