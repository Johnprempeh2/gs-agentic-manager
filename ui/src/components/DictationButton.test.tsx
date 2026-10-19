// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { appendDictatedText } from "./DictationButton";
import {
  FakeSpeechRecognition,
  installFakeSpeechRecognition,
  removeFakeSpeechRecognition,
} from "../fixtures/fakeSpeechRecognition";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("appendDictatedText", () => {
  it("joins heard words onto the draft with one space", () => {
    expect(appendDictatedText("", " hello ")).toBe("hello");
    expect(appendDictatedText("Please", "check this")).toBe("Please check this");
    expect(appendDictatedText("Please ", "check")).toBe("Please check");
    expect(appendDictatedText("Line one\n", "two")).toBe("Line one\ntwo");
    expect(appendDictatedText("Keep", "  ")).toBe("Keep");
  });
});

function Harness({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return <ChatComposer value={value} onChange={setValue} onSubmit={() => onSubmit(value)} />;
}

describe("ChatComposer dictation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    removeFakeSpeechRecognition();
  });

  const mic = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-composer-dictation"]');
  const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')!;
  const interim = () => container.querySelector('[data-testid="chat-composer-dictation-interim"]');

  function type(text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("hides the mic when the browser has no speech recognition", () => {
    act(() => root.render(<Harness onSubmit={() => {}} />));
    expect(mic()).toBeNull();
  });

  it("adds spoken words after typed text, then stops listening on send", () => {
    installFakeSpeechRecognition();
    const onSubmit = vi.fn();
    act(() => root.render(<Harness onSubmit={onSubmit} />));
    expect(mic()!.getAttribute("aria-label")).toBe("Dictate message");

    act(() => type("Please"));
    act(() => mic()!.click());
    const recognition = FakeSpeechRecognition.last();
    expect(recognition.started).toBe(true);
    expect(mic()!.getAttribute("aria-pressed")).toBe("true");
    expect(mic()!.getAttribute("aria-label")).toBe("Stop dictation");
    expect(interim()?.textContent).toContain("Listening…");

    act(() => recognition.hear("check the", false));
    expect(interim()?.textContent).toContain("check the");
    expect(input().value).toBe("Please");

    act(() => recognition.hear("check the invoice", true));
    expect(input().value).toBe("Please check the invoice");

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
    expect(onSubmit).toHaveBeenCalledWith("Please check the invoice");
    expect(recognition.stopped).toBe(true);
    expect(interim()).toBeNull();
    expect(mic()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the mic after the microphone permission is refused", () => {
    installFakeSpeechRecognition();
    act(() => root.render(<Harness onSubmit={() => {}} />));
    act(() => mic()!.click());
    act(() => FakeSpeechRecognition.last().onerror?.({ error: "not-allowed" }));
    expect(mic()).toBeNull();
  });
});
