import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** A pill that opens a one-choice menu; the list toolbars on Deliverables and Links use it. */
export function FilterMenu<T extends string>({
  label,
  value,
  allLabel,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T | null;
  allLabel: string;
  options: { value: T; label: string }[];
  onChange: (value: T | null) => void;
  testId: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-foreground/20 bg-accent text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {selected ? `${label}: ${selected.label}` : label}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)} className="justify-between">
          {allLabel}
          {!selected ? <Check className="h-3.5 w-3.5" /> : null}
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)} className="justify-between">
            <span className="truncate">{option.label}</span>
            {option.value === value ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
