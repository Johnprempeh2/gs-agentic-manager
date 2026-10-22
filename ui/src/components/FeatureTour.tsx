import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsPhone } from "@/hooks/useIsPhone";
import { useTourSeen } from "@/hooks/useTourSeen";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { TourDefinition, TourStep } from "@/lib/feature-tours";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * The first visible element for a step, or null when the page does not show it.
 * A step names a `data-tour` anchor, or the `data-testid` a page already has, so
 * tours can point at stable ids without touching pages other people are changing.
 */
export function findTourTarget(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"], [data-testid="${target}"]`)) {
    if (typeof el.checkVisibility !== "function" || el.checkVisibility()) return el;
  }
  return null;
}

/** `el` is null for a step about the page as a whole. */
type ShownStep = TourStep & { el: HTMLElement | null };

/**
 * A short guided tour for a feature page: opens by itself the first time a
 * person visits (once per tour version), and again from the "Show me around"
 * button it renders. Steps whose element is not on the page are skipped; a
 * step with no target is a card near the top of the screen. Tours with
 * `autoStart: false` never open by themselves: the button carries a dot
 * until the tour is seen.
 * `onClose` runs when the tour ends, so a page can put back the scroll the steps moved.
 */
export function FeatureTour({
  tour,
  className,
  onClose,
}: {
  tour: TourDefinition;
  className?: string;
  onClose?: () => void;
}) {
  const { data: settings, isFetched: flagsFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // A tour with no feature switch is always on and need not wait for the switches.
  const ready = tour.flag ? flagsFetched : true;
  const enabled = tour.flag ? settings?.[tour.flag] === true : true;
  const autoStart = tour.autoStart !== false;
  const { isSeen, markSeen } = useTourSeen();
  const seen = isSeen(tour);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tour") === tour.id;
  const autoStarted = useRef(false);

  const [steps, setSteps] = useState<ShownStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const helpRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const isPhone = useIsPhone();
  const reducedMotion = usePrefersReducedMotion();

  // Before the page has drawn any of the tour's elements, wait (return false)
  // unless a person asked for the tour: then the general cards are enough.
  const start = useCallback((asked = false) => {
    const shown = tour.steps.flatMap((step): ShownStep[] => {
      if (!step.target) return [{ ...step, el: null }];
      const el = findTourTarget(step.target);
      return el ? [{ ...step, el }] : [];
    });
    const targeted = tour.steps.some((step) => step.target);
    if (shown.length === 0 || (targeted && !asked && !shown.some((step) => step.el))) return false;
    setIndex(0);
    setSteps(shown);
    return true;
  }, [tour]);

  // Started from Tutorials (?tour=<id>): start now, seen or not, giving the page's
  // content a moment to load, then drop the parameter so a reload does not replay it.
  useEffect(() => {
    if (!ready || !enabled || !requested) return;
    autoStarted.current = true;
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      tries += 1;
      if (start(tries >= 20) || tries >= 20) {
        setSearchParams((params) => { params.delete("tour"); return params; }, { replace: true });
        return;
      }
      timer = window.setTimeout(attempt, 150);
    };
    timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  }, [ready, enabled, requested, start, setSearchParams]);

  // First visit: once the seen state is known (never while loading, so no flash),
  // wait a tick so the page's own content has rendered.
  useEffect(() => {
    if (!ready || !enabled || !autoStart || requested || seen !== false || autoStarted.current) return;
    const timer = window.setTimeout(() => {
      autoStarted.current = true;
      start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, enabled, autoStart, requested, seen, start]);

  const step = steps?.[index] ?? null;
  const last = steps ? index === steps.length - 1 : false;

  useEffect(() => {
    if (!step) return;
    nextRef.current?.focus();
    const el = step.el;
    if (!el) return;
    el.setAttribute("data-tour-active", "");
    el.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    return () => el.removeAttribute("data-tour-active");
  }, [step, reducedMotion]);

  // On a phone the card sits along the bottom of the screen, like a sheet. A
  // general card on a wider screen hangs from the top centre, under the page bar.
  const general = !step?.el;
  const anchorRef = useMemo(() => ({
    current: {
      getBoundingClientRect: () =>
        isPhone || !step
          ? new DOMRect(16, window.innerHeight - 16, window.innerWidth - 32, 0)
          : step.el
            ? step.el.getBoundingClientRect()
            : new DOMRect(window.innerWidth / 2, 72, 0, 0),
    },
  }), [isPhone, step]);

  // Done, Skip, Escape or a click away all count as seen. Replaying never resets it.
  const close = () => {
    if (steps) markSeen(tour);
    setSteps(null);
    if (steps) onClose?.();
  };
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

  if (!ready || !enabled) return null;
  const showDot = !autoStart && seen === false;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
      <Button
        ref={helpRef}
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        onClick={() => start(true)}
        aria-label={`Show me around ${tour.label}${showDot ? " (not seen yet)" : ""}`}
      >
        <span className="relative inline-flex">
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
          {showDot ? (
            <span
              aria-hidden="true"
              data-testid="feature-tour-new-dot"
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background motion-safe:animate-pulse"
            />
          ) : null}
        </span>
        <span className="max-sm:sr-only @max-4xl/bar:sr-only">Show me around</span>
      </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Show me around {tour.label}</TooltipContent>
      </Tooltip>
      <Popover open={Boolean(step)} onOpenChange={(open) => { if (!open) close(); }}>
        <PopoverAnchor virtualRef={anchorRef} />
        {step && steps ? (
          <PopoverContent
            side={isPhone ? "top" : "bottom"}
            align={isPhone || general ? "center" : "start"}
            sideOffset={isPhone ? 0 : 12}
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            onOpenAutoFocus={(event) => { event.preventDefault(); nextRef.current?.focus(); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); helpRef.current?.focus({ preventScroll: Boolean(onClose) }); }}
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
