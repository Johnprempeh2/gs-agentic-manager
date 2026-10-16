// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADD_TO_HOME_SCREEN_SNOOZE_MS, AddToHomeScreen, isIphoneSafari } from "./AddToHomeScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

function setUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

function buttonByText(text: string) {
  return Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

describe("AddToHomeScreen", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalUserAgent = window.navigator.userAgent;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    setUserAgent(originalUserAgent);
  });

  const render = (now = 1_000_000) => act(() => root.render(<AddToHomeScreen now={() => now} />));

  it("tells iPhone Safari apart from other iPhone browsers", () => {
    expect(isIphoneSafari(IPHONE_SAFARI)).toBe(true);
    expect(isIphoneSafari(IPHONE_SAFARI.replace("Version/17.5", "CriOS/128.0"))).toBe(false);
    expect(isIphoneSafari(ANDROID_CHROME)).toBe(false);
  });

  it("walks an iPhone through the three Safari steps", async () => {
    setUserAgent(IPHONE_SAFARI);
    render();
    expect(container.textContent).toContain("Put GSAM on your Home Screen");
    await act(async () => buttonByText("Show me how")!.click());
    expect(document.body.textContent).toContain("Tap the Share button at the bottom of Safari.");
    expect(document.body.textContent).toContain("notifications only work from the Home Screen app");
  });

  it("stays hidden for two weeks after Not now", () => {
    setUserAgent(IPHONE_SAFARI);
    render(1_000_000);
    act(() => buttonByText("Not now")!.click());
    expect(container.textContent).toBe("");

    act(() => root.unmount());
    root = createRoot(container);
    render(1_000_000 + ADD_TO_HOME_SCREEN_SNOOZE_MS - 1);
    expect(container.textContent).toBe("");

    act(() => root.unmount());
    root = createRoot(container);
    render(1_000_000 + ADD_TO_HOME_SCREEN_SNOOZE_MS + 1);
    expect(container.textContent).toContain("Put GSAM on your Home Screen");
  });

  it("uses Chrome's own install prompt on Android", async () => {
    setUserAgent(ANDROID_CHROME);
    render();
    expect(container.textContent).toBe("");

    const prompt = vi.fn(async () => {});
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(container.textContent).toContain("Put GSAM on your Home Screen");

    await act(async () => buttonByText("Add to Home Screen")!.click());
    expect(prompt).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  });

  it("shows nothing on a browser that cannot install", () => {
    setUserAgent(ANDROID_CHROME);
    render();
    expect(container.textContent).toBe("");
  });
});
