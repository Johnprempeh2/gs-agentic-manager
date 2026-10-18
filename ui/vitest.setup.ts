import { vi } from "vitest";

// The release test gate (GSAM_VITEST_TIMEOUT_MS) stretches the default test and
// hook timeouts for its 13 parallel lanes; stretch vi.waitFor's 1s default with
// them. A wait still returns as soon as its condition holds, and a call that
// passes its own timeout keeps it. Under gate load a background write the test
// waits for took longer than 1s (chat-channels, 18 Oct 2026).
if (Number(process.env.GSAM_VITEST_TIMEOUT_MS) > 0) {
  const waitFor = vi.waitFor;
  vi.waitFor = ((callback, options) =>
    waitFor(callback, typeof options === "number" ? options : { timeout: 10_000, ...options })) as typeof vi.waitFor;
}

const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}

// jsdom does not implement Element.prototype.scrollIntoView. Several surfaces
// (e.g. IssueChatThread's auto-scroll-to-latest) call it during normal render,
// so provide a no-op default. Tests that assert on scroll behaviour override
// this on the prototype themselves and restore it afterwards.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
