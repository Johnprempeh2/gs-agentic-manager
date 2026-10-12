import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { isChromelessDisplayMode } from "../lib/pwa-display-mode";
import { cn } from "../lib/utils";

/** Finger travel (after resistance) that arms a refresh. */
const TRIGGER = 72;
/** The indicator never travels further than this. */
const MAX_PULL = 110;
/** Pull feels heavier than the finger, like a native list. */
const RESISTANCE = 0.5;

type Phase = "idle" | "pulling" | "armed" | "refreshing";

/**
 * Pull down at the top of a page to refresh, in the Home Screen app only
 * (Safari has its own, and a full-screen app has no reload button). It
 * refetches the data on screen instead of reloading the page, so it is quick
 * and keeps your place. Pulls that start inside a scrolled box, a dialog or
 * the open menu are left alone.
 */
export function PullToRefresh({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const [pull, setPull] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const start = useRef<{ y: number; x: number } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  useEffect(() => {
    if (!enabled || !isChromelessDisplayMode()) return;

    const startsInsideScroller = (target: EventTarget | null) => {
      for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
        if (el.closest("[role='dialog'], [data-radix-popper-content-wrapper]")) return true;
        if (el.scrollTop > 0) return true;
      }
      return false;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (phaseRef.current === "refreshing" || event.touches.length !== 1) return;
      if ((window.scrollY || document.documentElement.scrollTop) > 0) return;
      if (startsInsideScroller(event.target)) return;
      const touch = event.touches[0]!;
      start.current = { y: touch.clientY, x: touch.clientX };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!start.current) return;
      const touch = event.touches[0]!;
      const dy = touch.clientY - start.current.y;
      const dx = Math.abs(touch.clientX - start.current.x);
      if (dy <= 0 || dx > dy) {
        if (phaseRef.current !== "idle") {
          setPull(0);
          setPhase("idle");
        }
        if (dx > dy) start.current = null;
        return;
      }
      const next = Math.min(MAX_PULL, dy * RESISTANCE);
      setPull(next);
      setPhase(next >= TRIGGER ? "armed" : "pulling");
    };

    const onTouchEnd = () => {
      if (!start.current) return;
      start.current = null;
      if (phaseRef.current !== "armed") {
        setPull(0);
        setPhase("idle");
        return;
      }
      setPhase("refreshing");
      setPull(TRIGGER);
      void queryClient
        .refetchQueries({ type: "active" })
        .catch(() => undefined)
        .finally(() => {
          setPull(0);
          setPhase("idle");
        });
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, queryClient]);

  if (phase === "idle") return null;
  const progress = Math.min(1, pull / TRIGGER);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={phase === "refreshing" ? "Refreshing" : phase === "armed" ? "Release to refresh" : "Pull to refresh"}
      className="pointer-events-none fixed inset-x-0 top-(--mobile-ptr-top) z-chrome flex justify-center"
      style={{ "--ptr-pull": `${pull}px`, opacity: progress } as CSSProperties}
    >
      <span
        className={cn(
          "gs-glass-float flex size-10 translate-y-(--ptr-pull) items-center justify-center rounded-full border border-border",
          phase === "armed" && "text-primary",
        )}
      >
        <RefreshCw
          className={cn("size-5", phase === "refreshing" && "animate-spin")}
          style={phase === "refreshing" ? undefined : { transform: `rotate(${Math.round(progress * 270)}deg)` }}
        />
      </span>
    </div>
  );
}
