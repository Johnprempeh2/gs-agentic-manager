import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { BrandMark } from "./BrandMark";

/**
 * A page title in the dashboard hero's language: the solid stone beside a
 * tight, heavy heading. Keep it for the few pages that carry the brand
 * (Decisions, Releases); ordinary pages use a plain heading.
 */
export function BrandPageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h1 className={cn("flex min-w-0 items-center gap-2 text-xl font-extrabold tracking-tight", className)}>
      <BrandMark decorative className="h-5 w-auto shrink-0" />
      <span className="truncate">{children}</span>
    </h1>
  );
}

/** Icon tile for "all caught up" empty states: the stone on the accent disc. */
export function BrandCaughtUpMark() {
  return (
    <div className="mb-4 flex size-18 items-center justify-center rounded-full bg-accent">
      <BrandMark decorative className="h-10 w-auto" />
    </div>
  );
}
