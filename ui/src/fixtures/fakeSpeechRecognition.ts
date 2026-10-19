import type { BrowserSpeechRecognition } from "../hooks/useDictation";

/**
 * Stand-in for the browser SpeechRecognition API in jsdom. Install it on
 * `window`, click the mic, then drive `hear()` / `end()` on the last instance.
 */
export class FakeSpeechRecognition implements BrowserSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: BrowserSpeechRecognition["onresult"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  started = false;
  stopped = false;

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
    this.onend?.();
  }

  abort() {
    this.stopped = true;
  }

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  static last(): FakeSpeechRecognition {
    return FakeSpeechRecognition.instances[FakeSpeechRecognition.instances.length - 1]!;
  }

  hear(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
  }
}

export function installFakeSpeechRecognition() {
  FakeSpeechRecognition.instances = [];
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeSpeechRecognition;
}

export function removeFakeSpeechRecognition() {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  FakeSpeechRecognition.instances = [];
}
