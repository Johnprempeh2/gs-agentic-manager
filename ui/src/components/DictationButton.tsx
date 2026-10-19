import { useRef } from "react";
import { Mic, MicOff } from "lucide-react";
import { useDictation, type Dictation } from "../hooks/useDictation";
import { cn } from "../lib/utils";

/**
 * Speak-to-type for the chat and comment composers (GRE-1669). Final words are
 * appended to the draft so the person can edit before sending; nothing sends
 * by itself. The button hides where the browser has no speech support.
 */

export function appendDictatedText(current: string, heard: string): string {
  const text = heard.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

/** Dictation wired to a composer draft. Always reads the latest draft. */
export function useComposerDictation(value: string, onChange: (next: string) => void): Dictation {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  return useDictation({
    onFinal: (heard) => {
      const next = appendDictatedText(valueRef.current, heard);
      if (next === valueRef.current) return;
      valueRef.current = next;
      onChangeRef.current(next);
    },
  });
}

export function DictationButton({
  dictation,
  disabled = false,
  className,
  testId = "composer-dictation",
}: {
  dictation: Dictation;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  if (!dictation.available) return null;
  const label = dictation.listening ? "Stop dictation" : "Dictate message";
  return (
    <button
      type="button"
      onClick={dictation.toggle}
      disabled={disabled && !dictation.listening}
      aria-pressed={dictation.listening}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "relative grid h-7 w-7 shrink-0 place-items-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        dictation.listening
          ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {dictation.listening ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
      {dictation.listening ? (
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-destructive"
        />
      ) : null}
    </button>
  );
}

/**
 * "Listening…" with the words heard so far, shown under the draft. Long speech
 * wraps to two lines and clips from the top, so the newest words stay visible.
 */
export function DictationInterim({
  dictation,
  className,
  testId = "composer-dictation-interim",
}: {
  dictation: Dictation;
  className?: string;
  testId?: string;
}) {
  if (!dictation.listening) return null;
  return (
    <div
      aria-live="polite"
      data-testid={testId}
      className={cn("mt-1 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground", className)}
    >
      <span className="shrink-0 font-medium text-destructive">Listening…</span>
      {dictation.interim ? (
        <span className="flex max-h-8 min-w-0 flex-col justify-end overflow-hidden">
          <span className="break-words italic">{dictation.interim}</span>
        </span>
      ) : null}
    </div>
  );
}
