import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reads a list of text parts aloud with the browser's own voice (Web Speech
 * API speechSynthesis). One utterance per part, so the part being read can be
 * highlighted and so Chrome's ~15s single-utterance cut-off never bites.
 *
 * Pause is cancel-and-remember rather than speechSynthesis.pause(): pause() is
 * unreliable in Chrome, and restarting at the part boundary also lets a speed
 * change take effect straight away.
 */
export interface SpeechReader {
  supported: boolean;
  playing: boolean;
  /** Index of the part being read, or last read while paused. */
  currentIndex: number | null;
  voices: SpeechSynthesisVoice[];
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
}

function getSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function"
    ? window.speechSynthesis
    : null;
}

export function useSpeechReader({
  parts,
  rate,
  voiceURI,
}: {
  parts: readonly string[];
  rate: number;
  voiceURI: string | null;
}): SpeechReader {
  const synth = getSynth();
  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth?.getVoices() ?? []);
  // Every speak/cancel bumps the generation; events from older utterances
  // (Safari fires `end` after cancel) are ignored.
  const generationRef = useRef(0);
  const indexRef = useRef<number | null>(null);
  const settingsRef = useRef({ parts, rate, voiceURI, voices });
  settingsRef.current = { parts, rate, voiceURI, voices };

  useEffect(() => {
    if (!synth) return;
    const update = () => setVoices(synth.getVoices());
    synth.addEventListener?.("voiceschanged", update);
    return () => synth.removeEventListener?.("voiceschanged", update);
  }, [synth]);

  const halt = useCallback(() => {
    generationRef.current += 1;
    synth?.cancel();
  }, [synth]);

  const speakFrom = useCallback(
    (start: number) => {
      if (!synth) return;
      const { parts: texts, rate: speed, voiceURI: uri, voices: available } = settingsRef.current;
      halt();
      if (start >= texts.length) {
        setPlaying(false);
        return;
      }
      const generation = generationRef.current;
      const voice = uri ? available.find((entry) => entry.voiceURI === uri) ?? null : null;
      setPlaying(true);
      indexRef.current = start;
      setCurrentIndex(start);
      for (let index = start; index < texts.length; index += 1) {
        const utterance = new SpeechSynthesisUtterance(texts[index]);
        utterance.rate = speed;
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        utterance.onstart = () => {
          if (generationRef.current !== generation) return;
          indexRef.current = index;
          setCurrentIndex(index);
        };
        if (index === texts.length - 1) {
          utterance.onend = () => {
            if (generationRef.current !== generation) return;
            indexRef.current = null;
            setCurrentIndex(null);
            setPlaying(false);
          };
        }
        utterance.onerror = (event) => {
          if (generationRef.current !== generation) return;
          if (event.error === "interrupted" || event.error === "canceled") return;
          setPlaying(false);
        };
        synth.speak(utterance);
      }
    },
    [halt, synth],
  );

  const play = useCallback(() => {
    speakFrom(indexRef.current ?? 0);
  }, [speakFrom]);

  const pause = useCallback(() => {
    halt();
    setPlaying(false);
  }, [halt]);

  const stop = useCallback(() => {
    halt();
    indexRef.current = null;
    setCurrentIndex(null);
    setPlaying(false);
  }, [halt]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

  // A speed or voice change mid-read restarts the current part with it.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    if (playingRef.current && indexRef.current != null) speakFrom(indexRef.current);
  }, [rate, voiceURI, speakFrom]);

  // New text (the next question) means a fresh start; never two voices at once.
  const partsKey = parts.join("\u0000");
  useEffect(() => stop, [partsKey, stop]);

  // Leaving the page (route change unmounts; tab close fires pagehide).
  useEffect(() => {
    if (!synth) return;
    const onPageHide = () => synth.cancel();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      generationRef.current += 1;
      synth.cancel();
    };
  }, [synth]);

  return { supported: synth !== null, playing, currentIndex, voices, play, pause, toggle, stop };
}
