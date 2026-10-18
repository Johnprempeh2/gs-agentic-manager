import { useState } from "react";
import { MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addReplySnippet, loadReplySnippets, removeReplySnippet, snippetLabel } from "../../lib/reply-snippets";

/** Composer menu of saved reply phrases: pick one to insert, or keep the current reply for next time. */
export function ReplySnippetsButton({
  currentBody,
  disabled,
  onInsert,
}: {
  currentBody: string;
  disabled?: boolean;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [snippets, setSnippets] = useState<string[]>(() => loadReplySnippets());
  const canSave = currentBody.trim().length > 0 && !snippets.includes(currentBody.trim());

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSnippets(loadReplySnippets());
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title="Saved replies"
          aria-label="Saved replies"
          data-testid="reply-snippets-trigger"
        >
          <MessageSquareText className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start" data-testid="reply-snippets-menu">
        {snippets.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No saved replies yet. Write a reply, then save it here.
          </p>
        ) : (
          snippets.map((snippet) => (
            <div key={snippet} className="group flex items-center gap-1 rounded hover:bg-accent/50">
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                title={snippet}
                onClick={() => {
                  onInsert(snippet);
                  setOpen(false);
                }}
              >
                {snippetLabel(snippet)}
              </button>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Remove saved reply: ${snippetLabel(snippet)}`}
                onClick={() => setSnippets((current) => removeReplySnippet(current, snippet))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))
        )}
        <div className="mt-1 border-t pt-1">
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50 disabled:opacity-50 disabled:hover:bg-transparent"
            disabled={!canSave}
            onClick={() => setSnippets((current) => addReplySnippet(current, currentBody))}
          >
            Save this reply for next time
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
