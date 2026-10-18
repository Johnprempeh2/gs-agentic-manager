import { useQuery } from "@tanstack/react-query";
import { GENERATED_IMAGE_VARIATIONS_MAX } from "@greatstone/shared";
import { studioLooksApi } from "../api/studioLooks";
import { queryKeys } from "../lib/queryKeys";

// Compare house looks: pick two to four saved looks and the studio makes the
// same description once in each, so the team can see which suits it best.

export function StudioLookCompare({
  companyId,
  selected,
  onChange,
  disabled,
}: {
  companyId: string;
  selected: string[];
  onChange: (lookIds: string[]) => void;
  disabled?: boolean;
}) {
  const looksQuery = useQuery({
    queryKey: queryKeys.studioLooks.list(companyId),
    queryFn: () => studioLooksApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const looks = looksQuery.data?.looks ?? [];
  if (looks.length < 2) return null;
  const full = selected.length >= GENERATED_IMAGE_VARIATIONS_MAX;

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);

  return (
    <fieldset className="space-y-2" disabled={disabled} data-testid="image-compare-looks">
      <legend className="text-sm font-medium">
        Compare looks? <span className="font-normal text-muted-foreground">(optional)</span>
      </legend>
      <div className="flex flex-wrap gap-2">
        {looks.map((look) => {
          const on = selected.includes(look.id);
          return (
            <button
              key={look.id}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => toggle(look.id)}
              className={
                on
                  ? "rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm ring-1 ring-primary"
                  : "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              }
            >
              {look.name}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selected.length >= 2
          ? `Makes one image in each of the ${selected.length} looks.`
          : `Pick two to ${GENERATED_IMAGE_VARIATIONS_MAX} looks to make the same image in each, side by side.`}
      </p>
    </fieldset>
  );
}
