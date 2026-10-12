import type { PipelineAccessLevel } from "@greatstone/shared";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export const PIPELINE_ACCESS_LEVEL_LABELS: Record<PipelineAccessLevel, string> = {
  view: "View",
  work_cases: "Work cases",
  administer: "Administer",
};

export const PIPELINE_ACCESS_LEVEL_HINTS: Record<PipelineAccessLevel, string> = {
  view: "Sees boards, cases, contacts and history.",
  work_cases: "Also creates, edits, moves and claims cases.",
  administer: "Also creates, renames and archives pipelines and edits stages and moves.",
};

const LEVELS: PipelineAccessLevel[] = ["view", "work_cases", "administer"];

/**
 * An agent's pipeline access level (GRE-1073). Viewers who may not change
 * grants see plain text, not a disabled control.
 */
export function PipelineAccessLevelSelect({
  value,
  label,
  canEdit,
  disabled = false,
  mixedLabel,
  className,
  onChange,
}: {
  /** null shows `mixedLabel` (levels differ across pipelines). */
  value: PipelineAccessLevel | null;
  /** Accessible name, e.g. "Harbor on Sales". */
  label: string;
  canEdit: boolean;
  disabled?: boolean;
  mixedLabel?: string;
  className?: string;
  onChange: (level: PipelineAccessLevel) => void;
}) {
  const text = value ? PIPELINE_ACCESS_LEVEL_LABELS[value] : (mixedLabel ?? "Mixed");
  if (!canEdit) {
    return (
      <span className={cn("text-sm", value === "view" || !value ? "text-muted-foreground" : "text-foreground", className)}>
        {text}
      </span>
    );
  }
  return (
    <NativeSelect
      aria-label={label}
      className={cn("h-8 w-36", className)}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value as PipelineAccessLevel | "";
        if (next) onChange(next);
      }}
    >
      {value === null ? <option value="" disabled>{text}</option> : null}
      {LEVELS.map((level) => (
        <option key={level} value={level}>{PIPELINE_ACCESS_LEVEL_LABELS[level]}</option>
      ))}
    </NativeSelect>
  );
}

/** "Changed by Grace, 2h ago" for one grant. */
export function pipelineAccessChangeText(
  change: { at: string; actorType: string; actorName: string | null } | null,
  timeAgo: (value: string) => string,
) {
  if (!change) return "Not changed yet";
  const who = change.actorName ?? (change.actorType === "user" ? "a board user" : "the system");
  return `Changed by ${who}, ${timeAgo(change.at)}`;
}

/** "Grace, 2h ago" under a matrix cell; empty when never changed. */
export function pipelineAccessChangeShort(
  change: { at: string; actorType: string; actorName: string | null } | null,
  timeAgo: (value: string) => string,
) {
  if (!change) return "";
  const who = change.actorName ?? (change.actorType === "user" ? "A board user" : "System");
  return `${who}, ${timeAgo(change.at)}`;
}
