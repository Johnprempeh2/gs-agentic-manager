import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  /** Optional bold heading rendered above the message. */
  title?: string;
  message: string;
  /** Optional secondary line rendered under the primary message. */
  description?: string;
  action?: string;
  onAction?: () => void;
  /** Hide the leading "+" glyph on the action button (e.g. for a "Set up" CTA). */
  hideActionIcon?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
}: EmptyStateProps) {
  return (
    <div className="gs-empty flex flex-col items-center justify-center py-16 text-center">
      <div className="gs-empty-tile gs-glass-card mb-5 rounded-2xl border p-4">
        <Icon className="brand-mark h-9 w-9" aria-hidden="true" />
      </div>
      {title ? (
        <>
          <p className="text-base font-semibold text-foreground mb-1.5">{title}</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">{message}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground mb-1">{message}</p>
          {description && <p className="max-w-md text-sm text-muted-foreground mb-4">{description}</p>}
        </>
      )}
      {action && onAction && (
        <Button onClick={onAction} className={title || description ? undefined : "mt-3"}>
          {!hideActionIcon && <Plus className="h-4 w-4 mr-1.5" />}
          {action}
        </Button>
      )}
    </div>
  );
}
