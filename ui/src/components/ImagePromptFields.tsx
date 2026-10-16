import { forwardRef, type KeyboardEvent } from "react";
import {
  GENERATED_IMAGE_PROMPT_MAX_LENGTH,
  IMAGE_SHAPE_OPTIONS,
  IMAGE_STYLE_PRESETS,
  type ImageAspectRatio,
  type ImageStylePresetId,
} from "@greatstone/shared";
import { Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Ready-made descriptions a first-time user can start from and edit. */
export const IMAGE_IDEA_STARTERS: ReadonlyArray<{ label: string; prompt: string; aspectRatio: ImageAspectRatio }> = [
  {
    label: "Social post",
    prompt: "Bright, friendly photo-style image of a small team celebrating a win in a modern office, natural light, no text",
    aspectRatio: "1:1",
  },
  {
    label: "Slide background",
    prompt: "Calm abstract background in deep navy and soft gold, gentle gradients and subtle shapes, plenty of empty space, no text",
    aspectRatio: "16:9",
  },
  {
    label: "Product shot",
    prompt: "Clean studio product photo of a sleek water bottle on a white surface, soft shadows, premium feel",
    aspectRatio: "4:3",
  },
  {
    label: "Illustration",
    prompt: "Flat vector illustration of a lighthouse guiding ships at dawn, warm colours, simple shapes, no text",
    aspectRatio: "16:9",
  },
  {
    label: "Event poster",
    prompt: "Bold poster artwork for an evening networking event in London, city skyline at dusk, elegant and modern, no text",
    aspectRatio: "3:4",
  },
];

export const IMAGE_ASPECT_STYLE: Record<ImageAspectRatio, string> = {
  "1:1": "1 / 1",
  "16:9": "16 / 9",
  "9:16": "9 / 16",
  "4:3": "4 / 3",
  "3:4": "3 / 4",
};

interface ImagePromptFieldsProps {
  idPrefix: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  aspectRatio: ImageAspectRatio;
  onAspectRatioChange: (aspectRatio: ImageAspectRatio) => void;
  /** When given, shows the style choice. Picking a style also picks its usual shape. */
  style?: ImageStylePresetId | null;
  onStyleChange?: (style: ImageStylePresetId | null) => void;
  onSubmitShortcut?: () => void;
  disabled?: boolean;
  /** Fewer shape columns, for a dialog. */
  compact?: boolean;
  placeholder?: string;
}

/** The description box, idea starters and shape picker shared by the Images page and the task dialog. */
export const ImagePromptFields = forwardRef<HTMLTextAreaElement, ImagePromptFieldsProps>(function ImagePromptFields(
  {
    idPrefix,
    prompt,
    onPromptChange,
    aspectRatio,
    onAspectRatioChange,
    style,
    onStyleChange,
    onSubmitShortcut,
    disabled,
    compact,
    placeholder,
  },
  ref,
) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmitShortcut?.();
    }
  };

  return (
    <>
      <div className="space-y-2">
        <label htmlFor={`${idPrefix}-prompt`} className="text-sm font-medium">
          What should the image show?
        </label>
        <Textarea
          id={`${idPrefix}-prompt`}
          ref={ref}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "For example: a watercolour of a busy London street market at dusk, soft warm light, no text"}
          maxLength={GENERATED_IMAGE_PROMPT_MAX_LENGTH}
          rows={3}
          disabled={disabled}
          data-testid="image-prompt"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Need an idea?
          </span>
          {IMAGE_IDEA_STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                onPromptChange(starter.prompt);
                onAspectRatioChange(starter.aspectRatio);
                if (ref && typeof ref === "object") ref.current?.focus();
              }}
              className="rounded-full border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starter.label}
            </button>
          ))}
        </div>
      </div>

      {onStyleChange ? (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="text-sm font-medium">Style</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Style" data-testid="image-style-picker">
            {[{ id: null, label: "Just my words", hint: "No extra styling" }, ...IMAGE_STYLE_PRESETS].map((preset) => {
              const selected = (style ?? null) === preset.id;
              return (
                <button
                  key={preset.id ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={preset.hint}
                  onClick={() => {
                    onStyleChange(preset.id);
                    if ("aspectRatio" in preset) onAspectRatioChange(preset.aspectRatio);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    selected
                      ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                      : "border-border text-foreground hover:bg-accent/40",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {(IMAGE_STYLE_PRESETS.find((preset) => preset.id === style)?.hint ?? "Describe it your way; nothing is added.")}
          </p>
        </fieldset>
      ) : null}

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">Shape</legend>
        <div
          className={cn("grid grid-cols-2 gap-2", compact ? "sm:grid-cols-3" : "sm:grid-cols-3 lg:grid-cols-5")}
          role="radiogroup"
          aria-label="Shape"
        >
          {IMAGE_SHAPE_OPTIONS.map((option) => {
            const selected = option.value === aspectRatio;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onAspectRatioChange(option.value)}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-accent/40",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("block w-6 shrink-0 rounded-sm border-2", selected ? "border-primary" : "border-muted-foreground/50")}
                  style={{ aspectRatio: IMAGE_ASPECT_STYLE[option.value] }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </>
  );
});
