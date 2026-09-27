import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { orderItemsBySelectedAndRecent } from "../lib/recent-selections";
import { cn } from "../lib/utils";

export interface InlineEntityOption {
  id: string;
  label: string;
  searchText?: string;
}

interface InlineEntitySelectorProps {
  value: string;
  options: InlineEntityOption[];
  placeholder: string;
  noneLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
  onChange: (id: string) => void;
  onConfirm?: () => void;
  className?: string;
  renderTriggerValue?: (option: InlineEntityOption | null) => ReactNode;
  renderOption?: (option: InlineEntityOption, isSelected: boolean) => ReactNode;
  recentOptionIds?: string[];
  /** Skip the Portal so the popover stays in the DOM tree (fixes scroll inside Dialogs). */
  disablePortal?: boolean;
  /** Open the popover when the trigger receives keyboard/programmatic focus. */
  openOnFocus?: boolean;
  /** Disable the trigger and prevent the popover from opening. */
  disabled?: boolean;
  /** Optional test id forwarded to the trigger button. */
  triggerTestId?: string;
  /** Optional slot name used by consuming surfaces for scoped presentation rules. */
  triggerDataSlot?: string;
  /** Runtime geometry variables for the portalled mobile picker sheet. */
  contentStyle?: CSSProperties;
  /**
   * Offer to create a new entity from the search text. Resolve with the new id to
   * select it; throw to keep the picker open and show the error inline.
   */
  onCreate?: (name: string) => Promise<string>;
  /** Label for the create row, e.g. `Create project "x"`; empty name means the plain entry. */
  createLabel?: (name: string) => string;
  /** Placeholder shown after the plain create entry is chosen, prompting for a name. */
  createNamePlaceholder?: string;
}

const CREATE_OPTION_ID = "__inline-entity-create__";
const defaultCreateLabel = (name: string) => (name ? `Create "${name}"` : "New");

const EMPTY_RECENT_OPTION_IDS: string[] = [];

export const InlineEntitySelector = forwardRef<HTMLButtonElement, InlineEntitySelectorProps>(
  function InlineEntitySelector(
    {
      value,
      options,
      placeholder,
      noneLabel,
      searchPlaceholder,
      emptyMessage,
      onChange,
      onConfirm,
      className,
      renderTriggerValue,
      renderOption,
      recentOptionIds = EMPTY_RECENT_OPTION_IDS,
      disablePortal,
      openOnFocus = true,
      disabled = false,
      triggerTestId,
      triggerDataSlot,
      contentStyle,
      onCreate,
      createLabel = defaultCreateLabel,
      createNamePlaceholder,
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const highlightedIndexRef = useRef(0);
    const [namingNew, setNamingNew] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const shouldPreventCloseAutoFocusRef = useRef(false);
    const isPointerDownRef = useRef(false);

    const allOptions = useMemo<InlineEntityOption[]>(() => {
      const baseOptions = [{ id: "", label: noneLabel, searchText: noneLabel }, ...options];
      return orderItemsBySelectedAndRecent(baseOptions, value, recentOptionIds);
    }, [noneLabel, options, recentOptionIds, value]);

    const filteredOptions = useMemo(() => {
      const term = query.trim().toLowerCase();
      if (!term) return allOptions;
      return allOptions.filter((option) => {
        const haystack = `${option.label} ${option.searchText ?? ""}`.toLowerCase();
        return haystack.includes(term);
      });
    }, [allOptions, query]);

    const createName = query.trim();
    const rows = useMemo<InlineEntityOption[]>(() => {
      if (!onCreate) return filteredOptions;
      const lowered = createName.toLowerCase();
      if (createName && options.some((option) => option.label.trim().toLowerCase() === lowered)) return filteredOptions;
      if (!createName && namingNew) return filteredOptions;
      return [...filteredOptions, { id: CREATE_OPTION_ID, label: createLabel(createName) }];
    }, [createLabel, createName, filteredOptions, namingNew, onCreate, options]);

    const resetTransientState = () => {
      setQuery("");
      setNamingNew(false);
      setCreateError(null);
    };

    const currentOption = options.find((option) => option.id === value) ?? null;

    const setHighlightedIndexValue = useCallback((next: number | ((current: number) => number)) => {
      const resolved = typeof next === "function" ? next(highlightedIndexRef.current) : next;
      highlightedIndexRef.current = resolved;
      setHighlightedIndex(resolved);
    }, []);

    useEffect(() => {
      if (!open) return;
      const selectedIndex = rows.findIndex((option) => option.id === value);
      // With no search match, land on the create row so Enter creates.
      const fallbackIndex = filteredOptions.length === 0 && rows.length > 0 ? rows.length - 1 : 0;
      setHighlightedIndexValue(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
    }, [filteredOptions.length, open, rows, setHighlightedIndexValue, value]);

    const closeAndConfirm = (moveNext: boolean) => {
      shouldPreventCloseAutoFocusRef.current = moveNext;
      setOpen(false);
      resetTransientState();
      if (moveNext && onConfirm) {
        requestAnimationFrame(() => {
          onConfirm();
        });
      }
    };

    const runCreate = async (moveNext: boolean) => {
      if (!onCreate || creating) return;
      if (!createName) {
        setNamingNew(true);
        setCreateError(null);
        inputRef.current?.focus();
        return;
      }
      setCreating(true);
      setCreateError(null);
      try {
        const createdId = await onCreate(createName);
        onChange(createdId);
        closeAndConfirm(moveNext);
      } catch (error) {
        setCreateError(error instanceof Error && error.message ? error.message : "Could not create. Try again.");
      } finally {
        setCreating(false);
      }
    };

    const commitSelection = (index: number, moveNext: boolean) => {
      const option = rows[index] ?? rows[0];
      if (option?.id === CREATE_OPTION_ID) {
        void runCreate(moveNext);
        return;
      }
      if (option) onChange(option.id);
      shouldPreventCloseAutoFocusRef.current = moveNext;
      setOpen(false);
      resetTransientState();
      if (moveNext && onConfirm) {
        requestAnimationFrame(() => {
          onConfirm();
        });
      }
    };

    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (disabled) return;
          if (!next && creating) return;
          setOpen(next);
          if (!next) resetTransientState();
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            data-testid={triggerTestId}
            data-slot={triggerDataSlot}
            className={cn(
              "inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none",
              className,
            )}
            onPointerDown={() => { isPointerDownRef.current = true; }}
            onFocus={() => {
              if (disabled) return;
              if (openOnFocus && !isPointerDownRef.current) setOpen(true);
              isPointerDownRef.current = false;
            }}
          >
            {renderTriggerValue
              ? renderTriggerValue(currentOption)
              : (currentOption?.label ?? <span className="text-muted-foreground">{placeholder}</span>)}
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-mobile-entity-picker=""
          align="start"
          side="bottom"
          collisionPadding={16}
          className="w-(--sz-calc-6) p-1"
          disablePortal={disablePortal}
          style={contentStyle}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!shouldPreventCloseAutoFocusRef.current) return;
            event.preventDefault();
            shouldPreventCloseAutoFocusRef.current = false;
          }}
        >
          <input
            ref={inputRef}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-subtle-foreground md:text-sm"
            placeholder={namingNew && createNamePlaceholder ? createNamePlaceholder : searchPlaceholder}
            value={query}
            readOnly={creating}
            onChange={(event) => {
              setQuery(event.target.value);
              setCreateError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                setHighlightedIndexValue((current) =>
                  rows.length === 0 ? 0 : (current + 1) % rows.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                setHighlightedIndexValue((current) => {
                  if (rows.length === 0) return 0;
                  return current <= 0 ? rows.length - 1 : current - 1;
                });
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commitSelection(highlightedIndexRef.current, true);
                return;
              }
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                commitSelection(highlightedIndexRef.current, true);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                resetTransientState();
              }
            }}
          />
          {createError ? (
            <p role="alert" className="px-2 pt-1.5 text-xs text-destructive">{createError}</p>
          ) : null}
          <div data-mobile-entity-picker-list="" className="max-h-56 overflow-y-auto overscroll-contain py-1 touch-pan-y">
            {filteredOptions.length === 0 && !onCreate ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            ) : (
              rows.map((option, index) => {
                const isSelected = option.id === value;
                const isHighlighted = index === highlightedIndex;
                if (option.id === CREATE_OPTION_ID) {
                  return (
                    <button
                      key={CREATE_OPTION_ID}
                      type="button"
                      disabled={creating}
                      data-inline-entity-create=""
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm touch-manipulation disabled:opacity-60",
                        isHighlighted && "bg-accent",
                      )}
                      onMouseEnter={() => setHighlightedIndexValue(index)}
                      onClick={() => void runCreate(true)}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{creating ? "Creating…" : option.label}</span>
                    </button>
                  );
                }
                return (
                  <button
                    key={option.id || "__none__"}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm touch-manipulation",
                      isHighlighted && "bg-accent",
                    )}
                    onMouseEnter={() => setHighlightedIndexValue(index)}
                    onClick={() => commitSelection(index, true)}
                  >
                    {renderOption ? renderOption(option, isSelected) : <span className="truncate">{option.label}</span>}
                    <Check className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground", isSelected ? "opacity-100" : "opacity-0")} />
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
