import type { ReactNode } from "react";
import { useFileIntake } from "../hooks/useFileIntake";
import { cn } from "../lib/utils";

/**
 * Wraps an upload button (or a row) so a file can also be dropped on it or
 * pasted into it. The highlight shows where the file will land.
 */
export function FileDropArea({
  onFiles,
  single = true,
  disabled = false,
  label,
  className,
  children,
  testId,
}: {
  onFiles: (files: File[]) => void;
  single?: boolean;
  disabled?: boolean;
  /** Read out for the drop target, for example "Drop or paste the signed NDA". */
  label: string;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const intake = useFileIntake(onFiles, { disabled, single });
  return (
    <div
      {...intake.targetProps}
      role="group"
      aria-label={label}
      title={label}
      data-testid={testId}
      data-dragging={intake.dragging || undefined}
      className={cn(
        "rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        intake.dragging && "bg-accent ring-2 ring-primary",
        className,
      )}
    >
      {children}
    </div>
  );
}
