import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { authApi } from "@/api/auth";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useIsPhone } from "@/hooks/useIsPhone";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { TourDefinition, TourStep } from "@/lib/feature-tours";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

// ponytail: "seen" lives in this browser's localStorage, keyed per user and tour
// version. There is no general per-user preferences table; add one (and read it
// here) if tours must stay dismissed across devices.
export function tourSeenKey(tour: Pick<TourDefinition, "id" | "version">, userId: string) {
  return `gsam.tour.${tour.id}.v${tour.version}.${userId}`;
}

function hasSeen(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return true; // Storage blocked: never nag on every visit. Replay still works.
  }
}

function markSeen(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked; nothing to remember.
  }
}

/** The first visible element for a step, or null when the page does not show it. */
export function findTourTarget(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return el;
  }
  return null;
}

type ShownStep = TourStep & { el: HTMLElement };

/**
 * A short guided tour for a feature page: opens by itself the first time a
 * person visits (once per tour version), and again from the "Show me around"
 * button it renders. Steps whose element is not on the page are skipped.
 */
export function FeatureTour({ tour, className }: { tour: TourDefinition; className?: string }) {
  const { data: settings, isFetched: flagsFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: session, isFetched: sessionFetched } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const enabled = settings?.[tour.flag] === true;
  const userId = session?.user?.id ?? session?.session?.userId ?? "local";
  const seenKey = tourSeenKey(tour, userId);

  const [steps, setSteps] = useState<ShownStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const helpRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const isPhone = useIsPhone();
  const reducedMotion = usePrefersReducedMotion();

  const start = useCallback(() => {
    const shown = tour.steps.flatMap((step) => {
      const el = findTourTarget(step.target);
      return el ? [{ ...step, el }] : [];
    });
    if (shown.length === 0) return false;
    setIndex(0);
    setSteps(shown);
    return true;
  }, [tour]);

  // First visit: wait a tick so the page's own content has rendered.
  useEffect(() => {
    if (!flagsFetched || !sessionFetched || !enabled || hasSeen(seenKey)) return;
    const timer = window.setTimeout(() => {
      if (start()) markSeen(seenKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [flagsFetched, sessionFetched, enabled, seenKey, start]);

  const step = steps?.[index] ?? null;
  const last = steps ? index === steps.length - 1 : false;

  useEffect(() => {
    if (!step) return;
    step.el.setAttribute("data-tour-active", "");
    step.el.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    nextRef.current?.focus();
    return () => step.el.removeAttribute("data-tour-active");
  }, [step, reducedMotion]);

  // On a phone the card sits along the bottom of the screen, like a sheet.
  const anchorRef = useMemo(() => ({
    current: {
      getBoundingClientRect: () =>
        isPhone || !step
          ? new DOMRect(16, window.innerHeight - 16, window.innerWidth - 32, 0)
          : step.el.getBoundingClientRect(),
    },
  }), [isPhone, step]);

  const close = () => setSteps(null);
  const go = (delta: number) => {
    if (!steps) return;
    const next = index + delta;
    if (next >= steps.length) close();
    else if (next >= 0) setIndex(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
  };

  if (!flagsFetched || !enabled) return null;

  return (
    <>
      <Button
        ref={helpRef}
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        onClick={start}
        aria-label={`Show me around ${tour.label}`}
      >
        <CircleHelp className="h-4 w-4" aria-hidden="true" />
        <span className="max-sm:sr-only">Show me around</span>
      </Button>
      <Popover open={Boolean(step)} onOpenChange={(open) => { if (!open) close(); }}>
        <PopoverAnchor virtualRef={anchorRef} />
        {step && steps ? (
          <PopoverContent
            side={isPhone ? "top" : "bottom"}
            align={isPhone ? "center" : "start"}
            sideOffset={isPhone ? 0 : 12}
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            onOpenAutoFocus={(event) => { event.preventDefault(); nextRef.current?.focus(); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); helpRef.current?.focus(); }}
            onKeyDown={onKeyDown}
            className={cn(
              "space-y-3 motion-reduce:animate-none",
              isPhone ? "w-(--radix-popper-anchor-width)" : "w-80",
            )}
            data-testid="feature-tour"
          >
            <div aria-live="polite" className="space-y-1">
              <p className="text-xs text-muted-foreground">Step {index + 1} of {steps.length}</p>
              <h2 id={titleId} className="text-sm font-semibold text-foreground">{step.title}</h2>
              <p id={bodyId} className="text-sm text-muted-foreground">{step.body}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={close}>Skip</Button>
              <div className="flex gap-2">
                {index > 0 ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => go(-1)}>Back</Button>
                ) : null}
                <Button ref={nextRef} type="button" size="sm" onClick={() => go(1)}>
                  {last ? "Done" : "Next"}
                </Button>
              </div>
            </div>
          </PopoverContent>
        ) : null}
      </Popover>
    </>
  );
}
