import { useEffect, useMemo, useState, type RefObject } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { useSpeechReader } from "../hooks/useSpeechReader";
import { Button } from "@/components/ui/button";

const BLOCK_SELECTOR = "h1, h2, h3, h4, p, li, blockquote, td";

/**
 * The text of a page section as parts to read aloud: one part per heading,
 * paragraph or list item, skipping anything marked `data-listen-skip` (buttons,
 * links to sources) and blocks nested in another block.
 */
export function listenPartsFrom(root: HTMLElement): string[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (block) => !block.closest("[data-listen-skip]") && !block.parentElement?.closest(BLOCK_SELECTOR),
  );
  const texts = (blocks.length > 0 ? blocks : [root]).map((block) => (block.innerText ?? block.textContent ?? "").replace(/\s+/g, " ").trim());
  return texts.filter((text) => text.length > 0);
}

/** A British English voice when the device has one, so names and spellings sound right. */
export function preferredVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((voice) => voice.lang === "en-GB" && voice.localService) ??
    voices.find((voice) => voice.lang === "en-GB") ??
    voices.find((voice) => voice.lang.startsWith("en")) ??
    null
  );
}

/**
 * "Listen": reads a section of the page aloud with the device's own voice, so a
 * briefing can be heard on the move. Nothing leaves the device and it costs
 * nothing. Hidden where the browser cannot speak.
 */
export function ListenButton({ targetRef, label = "Listen" }: { targetRef: RefObject<HTMLElement | null>; label?: string }) {
  const [parts, setParts] = useState<string[]>([]);
  const [startRequested, setStartRequested] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const voiceURI = useMemo(() => preferredVoice(voices)?.voiceURI ?? null, [voices]);
  const reader = useSpeechReader({ parts, rate: 1, voiceURI });

  useEffect(() => {
    setVoices(reader.voices);
  }, [reader.voices]);

  // Start once the freshly read text has reached the reader.
  useEffect(() => {
    if (!startRequested) return;
    setStartRequested(false);
    reader.play();
  }, [startRequested, reader]);

  if (!reader.supported) return null;

  const started = reader.playing || reader.currentIndex != null;

  function start() {
    const root = targetRef.current;
    if (!root) return;
    setParts(listenPartsFrom(root));
    setStartRequested(true);
  }

  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label="Read aloud">
      {!started ? (
        <Button size="sm" variant="outline" onClick={start}>
          <Volume2 className="size-3.5" aria-hidden />
          {label}
        </Button>
      ) : (
        <>
          <Button size="sm" variant="outline" onClick={reader.toggle} aria-label={reader.playing ? "Pause reading" : "Carry on reading"}>
            {reader.playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {reader.playing ? "Pause" : "Resume"}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={reader.stop} aria-label="Stop reading">
            <Square className="size-3.5" aria-hidden />
          </Button>
          {reader.currentIndex != null ? (
            <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {reader.currentIndex + 1} of {parts.length}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
