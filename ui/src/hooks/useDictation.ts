import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser speech-to-text (Web Speech API SpeechRecognition; `webkit` prefix in
 * Chrome and Safari). Firefox has none, so `available` is false and callers hide
 * the mic. A refused microphone permission also turns `available` off for the
 * rest of the browser session, so the mic does not keep asking.
 */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent {
  error: string;
}
export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => BrowserSpeechRecognition;

export const MIC_DENIED_KEY = "paperclip:attention:focus-mic-denied";

export function getSpeechRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function readDenied(): boolean {
  try {
    return sessionStorage.getItem(MIC_DENIED_KEY) === "1";
  } catch {
    return false;
  }
}

export interface Dictation {
  available: boolean;
  listening: boolean;
  /** Words heard but not yet final — show them greyed after the note. */
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useDictation({ onFinal }: { onFinal: (text: string) => void }): Dictation {
  const Recognition = getSpeechRecognitionConstructor();
  const [denied, setDenied] = useState(readDenied);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Recognition || denied || recognitionRef.current) return;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    recognition.onresult = (event) => {
      let pending = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        const text = result[0].transcript;
        if (result.isFinal) onFinalRef.current(text.trim());
        else pending += text;
      }
      setInterim(pending.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        try {
          sessionStorage.setItem(MIC_DENIED_KEY, "1");
        } catch {
          // Ignore storage failures; state still hides the mic.
        }
        setDenied(true);
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setInterim("");
      setListening(false);
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  }, [Recognition, denied]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return { available: Recognition !== null && !denied, listening, interim, start, stop, toggle };
}
