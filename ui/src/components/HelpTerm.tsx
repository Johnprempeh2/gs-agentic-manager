import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { glossaryEntry } from "@/lib/glossary";
import { Link } from "@/lib/router";

/**
 * A word with a dotted underline. Select it to read what it means in plain words.
 * Falls back to plain text when the word is not in the glossary.
 */
export function HelpTerm({ term, children }: { term: string; children?: ReactNode }) {
  const entry = glossaryEntry(term);
  const label = children ?? entry?.term.toLowerCase() ?? term;
  if (!entry) return <>{label}</>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-help underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:text-foreground"
          aria-label={`${typeof label === "string" ? label : entry.term}: what does this mean?`}
          data-testid={`help-term-${entry.id}`}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="space-y-2 text-sm">
        <p className="font-semibold text-foreground">{entry.term}</p>
        <p className="text-muted-foreground">{entry.plain}</p>
        {entry.example ? <p className="text-muted-foreground">For example: {entry.example}</p> : null}
        <Link to="/tutorials#words" className="inline-block text-sm font-medium text-foreground underline underline-offset-4">
          See all the words we use
        </Link>
      </PopoverContent>
    </Popover>
  );
}
