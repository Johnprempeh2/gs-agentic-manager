import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  /** The failure. An Error shows its message; anything else shows the fallback line. */
  error: unknown;
  /** Heading above the message. Defaults by size: a failed load, or a failed refresh. */
  title?: string;
  /** Called by the "Try again" button. Omit to hide the button. */
  onRetry?: () => void;
  /** Disables the retry button while the retry is in flight. */
  retrying?: boolean;
  /** Smaller banner for when a refresh failed and older data is still on the page. */
  compact?: boolean;
  className?: string;
}

export function errorStateMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Something went wrong.";
}

/** The shared "could not load" surface: what failed, why, and one way to try again. */
export function ErrorState({
  error,
  title,
  onRetry,
  retrying = false,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-6" : "py-16",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-xl border border-status-danger/30 bg-status-danger-soft text-status-danger",
          compact ? "mb-3 p-2.5" : "mb-5 p-4",
        )}
      >
        <AlertTriangle className={compact ? "h-5 w-5" : "h-9 w-9"} aria-hidden="true" />
      </div>
      <p className="mb-1 text-sm font-semibold text-foreground">
        {title ?? (compact ? "Could not refresh" : "Could not load this page")}
      </p>
      <p className="mb-4 max-w-md break-words text-sm text-muted-foreground">{errorStateMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size={compact ? "sm" : "default"} onClick={onRetry} disabled={retrying}>
          <RotateCw className={cn("mr-1.5 h-4 w-4", retrying && "animate-spin")} aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
