// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListenButton, listenPartsFrom, preferredVoice } from "./ListenButton";

class FakeUtterance {
  rate = 1;
  voice: unknown = null;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const synth = {
  speak: vi.fn((utterance: FakeUtterance) => utterance.onstart?.()),
  cancel: vi.fn(),
  getVoices: () => [] as SpeechSynthesisVoice[],
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <ListenButton targetRef={ref} label="Listen to the Pulse" />
      <div ref={ref}>
        <h2>Quick win</h2>
        <p>Try the new model on the proposal drafts.</p>
        <ul>
          <li>First point</li>
        </ul>
      </div>
    </div>
  );
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(window, { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });
  synth.speak.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ListenButton", () => {
  it("reads each heading, paragraph and list item of the section aloud", () => {
    act(() => root.render(<Harness />));
    act(() => button("Listen to the Pulse").click());
    expect(synth.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      "Quick win",
      "Try the new model on the proposal drafts.",
      "First point",
    ]);
    expect(button("Pause reading")).toBeTruthy();
    act(() => button("Stop reading").click());
    expect(button("Listen to the Pulse")).toBeTruthy();
  });
});

describe("listen helpers", () => {
  it("skips marked blocks and nested blocks", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>One</p><div data-listen-skip><p>Skip me</p></div><ul><li><p>Nested</p></li></ul>';
    expect(listenPartsFrom(root)).toEqual(["One", "Nested"]);
  });

  it("prefers a British voice", () => {
    const voices = [
      { lang: "en-US", localService: true, voiceURI: "us" },
      { lang: "en-GB", localService: false, voiceURI: "gb-remote" },
      { lang: "en-GB", localService: true, voiceURI: "gb-local" },
    ] as SpeechSynthesisVoice[];
    expect(preferredVoice(voices)?.voiceURI).toBe("gb-local");
    expect(preferredVoice([])).toBeNull();
  });
});
