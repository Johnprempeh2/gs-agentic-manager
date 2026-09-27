import { useId, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  AGENT_PALETTE_GROUPS,
  agentPaletteLabel,
  appearanceForPalette,
  isGreatstoneAgentPalette,
  type AgentAppearance,
  type AgentAvatarSize,
  type AgentPaletteId,
} from "@greatstone/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";

const GROUP_LAYOUT: Record<(typeof AGENT_PALETTE_GROUPS)[number]["id"], { columns: string; size: AgentAvatarSize }> = {
  greatstone: { columns: "grid-cols-4", size: 48 },
  classic: { columns: "grid-cols-6", size: 32 },
};

export function agentPaletteDescription(paletteId: string) {
  return `${agentPaletteLabel(paletteId)}, ${isGreatstoneAgentPalette(paletteId) ? "Greatstone" : "Classic"}`;
}

interface AgentPaletteGridProps {
  value: AgentPaletteId;
  onChange: (paletteId: AgentPaletteId) => void;
  disabled?: boolean;
}

/**
 * Every agent palette as one native radio group, Greatstone first. Native
 * radios give Tab-into-group and arrow-key selection for free; each tile shows
 * the real character in that palette plus a check mark (not colour alone) on
 * the chosen one.
 */
export function AgentPaletteGrid({ value, onChange, disabled }: AgentPaletteGridProps) {
  const name = useId();
  return (
    <div className="space-y-3">
      {AGENT_PALETTE_GROUPS.map((group) => {
        const layout = GROUP_LAYOUT[group.id];
        return (
          <fieldset key={group.id} className="min-w-0 space-y-1.5" disabled={disabled}>
            <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</legend>
            <div className={cn("grid gap-1", layout.columns)}>
              {group.paletteIds.map((paletteId) => {
                const label = agentPaletteLabel(paletteId);
                return (
                  <label key={paletteId} title={label} data-palette-id={paletteId} className="relative flex cursor-pointer justify-center">
                    <input
                      type="radio"
                      name={name}
                      value={paletteId}
                      checked={value === paletteId}
                      onChange={() => onChange(paletteId)}
                      aria-label={label}
                      className="peer sr-only"
                    />
                    <span className="flex w-full justify-center rounded-md border-2 border-transparent p-0.5 transition-colors hover:bg-accent/60 peer-checked:border-primary peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed">
                      <AgentAvatar appearance={appearanceForPalette(paletteId)} size={layout.size} />
                    </span>
                    <span aria-hidden="true" className="absolute right-0 top-0 hidden size-4 items-center justify-center rounded-full bg-primary text-primary-foreground peer-checked:flex">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

interface AgentAppearancePickerProps {
  /** The agent's stored appearance. */
  value: AgentAppearance;
  agentName: string;
  /** Persist the choice. The popover closes when this resolves and stays open with the message if it rejects. */
  onSave: (appearance: AgentAppearance) => Promise<unknown> | unknown;
  /** The trigger, rendered with `asChild`: pass a button. */
  children: ReactNode;
  align?: "start" | "center" | "end";
}

/**
 * Change an agent's colour: a popover with a live preview of the agent in the
 * chosen palette, every palette grouped Greatstone first, and explicit
 * Save / Cancel so browsing never writes.
 */
export function AgentAppearancePicker({ value, agentName, onSave, children, align = "start" }: AgentAppearancePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AgentPaletteId>(value.paletteId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const changed = draft !== value.paletteId;

  function handleOpenChange(next: boolean) {
    if (saving) return;
    if (next) {
      setDraft(value.paletteId);
      setError(null);
    }
    setOpen(next);
  }

  async function save() {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(appearanceForPalette(draft));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not save the colour. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        ref={contentRef}
        role="dialog"
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => {
          // Land on the current palette, as Tab into a radio group would.
          const checked = contentRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
          if (!checked) return;
          event.preventDefault();
          checked.focus();
        }}
        className="w-80 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-y-auto p-4"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <AgentAvatar appearance={appearanceForPalette(draft)} size={64} label={`${agentName} in ${agentPaletteLabel(draft)}`} name={agentName} />
            <div className="min-w-0 space-y-0.5">
              <h2 id={titleId} className="text-sm font-semibold">Agent colour</h2>
              <p className="truncate text-sm">{agentName}</p>
              <p className="text-xs text-muted-foreground" aria-live="polite">{agentPaletteDescription(draft)}</p>
            </div>
          </div>
          <AgentPaletteGrid value={draft} onChange={setDraft} disabled={saving} />
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={save} disabled={!changed || saving}>{saving ? "Saving..." : "Save colour"}</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
