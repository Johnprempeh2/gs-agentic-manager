import { useMemo } from "react";
import { History, MessageCircle, Pin, Star, X } from "lucide-react";
import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";
import { loadRecentSearches } from "../../lib/recent-searches";
import { SUGGESTED_QUESTIONS } from "../../lib/ask-everest";
import type { SavedSearchItem } from "../../lib/saved-searches";

/**
 * What the search box offers before anything is typed: saved searches,
 * recent searches, and questions to ask the lead agent. Recently opened
 * tasks lead the palette itself (CommandPalette).
 */
export function GlobalSearchEmptyState({
  companyId,
  leadName,
  saved = [],
  onRemoveSaved,
  onGo,
  onSearch,
  onAsk,
}: {
  companyId: string;
  leadName: string | null;
  saved?: readonly SavedSearchItem[];
  onRemoveSaved?: (id: string) => void;
  onGo: (path: string) => void;
  onSearch: (query: string) => void;
  onAsk: (question: string) => void;
}) {
  const recentSearches = useMemo(() => loadRecentSearches(companyId).slice(0, 3), [companyId]);

  return (
    <>
      {saved.length > 0 ? (
        <>
          <CommandGroup heading="Saved and pinned">
            {saved.map((item) => (
              <CommandItem
                key={item.id}
                value={`saved ${item.id} ${item.label}`}
                onSelect={() => (item.kind === "search" ? onSearch(item.query) : onGo(item.path))}
                data-testid="global-search-saved"
              >
                {item.kind === "search" ? <Star className="mr-2 h-4 w-4 shrink-0" /> : <Pin className="mr-2 h-4 w-4 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {onRemoveSaved ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.label}`}
                    className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onRemoveSaved(item.id);
                    }}
                    data-testid="global-search-saved-remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
        </>
      ) : null}
      {recentSearches.length > 0 ? (
        <>
          <CommandGroup heading="Recent searches">
            {recentSearches.map((search) => (
              <CommandItem
                key={search}
                value={`recent-search ${search}`}
                onSelect={() => onSearch(search)}
                data-testid="global-search-recent-search"
              >
                <History className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{search}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}

      {leadName ? (
        <>
          {recentSearches.length > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading={`Ask ${leadName}`}>
            {SUGGESTED_QUESTIONS.map((question) => (
              <CommandItem
                key={question}
                value={`ask-suggestion ${question}`}
                onSelect={() => onAsk(question)}
                data-testid="global-search-ask-suggestion"
              >
                <MessageCircle className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{question}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}
      <CommandSeparator />
    </>
  );
}
