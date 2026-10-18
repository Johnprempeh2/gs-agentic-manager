import { Clapperboard } from "lucide-react";
import { GENERATED_IMAGE_SHOT_MAX_LENGTH, GENERATED_IMAGE_VARIATIONS_MAX } from "@greatstone/shared";
import { Input } from "@/components/ui/input";

// Storyboard: up to four short shot lines that share the main description and
// look, so a campaign's pictures belong together.

export function StudioShotList({
  shots,
  onChange,
  disabled,
}: {
  shots: string[];
  onChange: (shots: string[]) => void;
  disabled?: boolean;
}) {
  const filled = shots.filter((shot) => shot.trim()).length;
  const rows = Array.from({ length: GENERATED_IMAGE_VARIATIONS_MAX }, (_, index) => shots[index] ?? "");
  const setShot = (index: number, value: string) => onChange(rows.map((shot, at) => (at === index ? value : shot)));

  return (
    <details className="rounded-md border border-border p-3" data-testid="image-storyboard" open={filled > 0 || undefined}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Clapperboard className="h-4 w-4 text-primary" aria-hidden="true" />
        Storyboard <span className="font-normal text-muted-foreground">(optional)</span>
        {filled > 0 ? <span className="ml-auto text-xs font-normal text-muted-foreground">{filled} shots</span> : null}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          Write two to {GENERATED_IMAGE_VARIATIONS_MAX} moments. Each becomes its own picture, with the description above and the
          same look, so they belong together.
        </p>
        {rows.map((shot, index) => (
          <Input
            key={index}
            aria-label={`Shot ${index + 1}`}
            placeholder={index === 0 ? "For example: a barista pours the first cup" : `Shot ${index + 1}`}
            value={shot}
            maxLength={GENERATED_IMAGE_SHOT_MAX_LENGTH}
            disabled={disabled}
            onChange={(event) => setShot(index, event.target.value)}
          />
        ))}
      </div>
    </details>
  );
}
