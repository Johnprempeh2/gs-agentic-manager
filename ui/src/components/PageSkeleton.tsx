import { Skeleton } from "@/components/ui/skeleton";

interface PageSkeletonProps {
  variant?:
    | "list"
    | "issues-list"
    | "detail"
    | "dashboard"
    | "approvals"
    | "costs"
    | "inbox"
    | "org-chart";
  /**
   * "issues-list" only: also draw the toolbar. Leave it off where the real
   * toolbar is already on screen above the skeleton (a task list does that).
   */
  toolbar?: boolean;
}

const ROW_TITLE_WIDTHS = ["w-2/5", "w-1/3", "w-1/2", "w-1/4", "w-3/5", "w-1/3", "w-2/5", "w-1/2"];

/**
 * Rows drawn like the task rows they stand in for: status ring, a title of
 * varying length, then the key and the time on the right. Same height as a
 * real row (40px, two lines on a phone), so nothing moves when the data lands.
 */
export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} data-slot="skeleton-row" className="flex h-20 items-start gap-3 px-3 pt-3 sm:h-10 sm:items-center sm:pt-0">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className={`h-3.5 ${ROW_TITLE_WIDTHS[i % ROW_TITLE_WIDTHS.length]}`} />
          <Skeleton className="ml-auto hidden h-3 w-12 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-3 w-10 shrink-0 sm:ml-6" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton({ variant = "list", toolbar = false }: PageSkeletonProps) {
  if (variant === "dashboard") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full border border-border" />

        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (variant === "approvals") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-44" />
        </div>
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (variant === "costs") {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>

        <Skeleton className="h-40 w-full" />

        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  // Only the list: the Inbox draws its real toolbar above this, so a fake one would jump.
  if (variant === "inbox") {
    return (
      <div aria-busy="true" aria-label="Loading the inbox" className="space-y-4">
        <Skeleton className="mx-auto h-4 w-16 rounded-full" />
        <SkeletonRows count={9} />
      </div>
    );
  }

  if (variant === "org-chart") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-(--sz-calc-17) w-full rounded-lg border border-border" />
      </div>
    );
  }

  if (variant === "detail") {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-3 w-64" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-7 w-48" />
          </div>
          <Skeleton className="h-4 w-40" />
        </div>

        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  // Only the list: a task list draws its real toolbar above this, so a fake
  // one would show two toolbars and then drop one.
  if (variant === "issues-list") {
    return (
      <div aria-busy="true" aria-label="Loading tasks" className="space-y-4">
        {toolbar ? (
          <div className="flex items-center gap-2">
            <Skeleton className="h-10 w-28" />
            <Skeleton className="h-10 min-w-0 flex-1 sm:w-56 sm:flex-none" />
            <Skeleton className="ml-auto hidden h-10 w-72 sm:block" />
          </div>
        ) : null}
        <Skeleton className="mx-auto h-4 w-16 rounded-full" />
        <SkeletonRows />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-9 w-44" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      {/* Rows drawn like the entity rows most lists use (Agents, Projects,
          Goals): an icon, a name over a line of detail, a chip on the right. */}
      <div className="overflow-hidden rounded-xl border border-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex h-14 items-center gap-3 border-b border-border px-4 last:border-b-0">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className={`h-3.5 ${ROW_TITLE_WIDTHS[i % ROW_TITLE_WIDTHS.length]}`} />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="hidden h-5 w-16 shrink-0 rounded-full sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
