import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type PushListener = (event: {
  data: { json: () => unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

function loadServiceWorker(windows: Array<{ url: string; focused: boolean }>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => {});
  const swSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows) },
    registration: { showNotification },
    location: { origin: "https://app.example.com" },
  };
  const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8")
    .replace("__GSAM_BUILD_ID__", "fixture-production");
  new Function("self", "caches", "fetch", "Response", "URL", code)(swSelf, {}, vi.fn(), Response, URL);
  const listener = listeners.get("push");
  if (!listener) throw new Error("sw.js registered no push listener");
  return { push: listener as PushListener, showNotification };
}

async function deliver(push: PushListener, payload: unknown) {
  let pending: Promise<unknown> | undefined;
  push({ data: { json: () => payload }, waitUntil: (promise) => { pending = promise; } });
  await pending;
}

const chatPush = { title: "John", body: "Hi", url: "/messages/chat-1#comment-c9", tag: "chat:chat-1" };

describe("sw.js chat push", () => {
  it("skips the alert when the chat is open and focused, even with a message anchor", async () => {
    const { push, showNotification } = loadServiceWorker([
      { url: "https://app.example.com/messages/chat-1", focused: true },
    ]);
    await deliver(push, chatPush);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("shows the alert when a different chat is focused", async () => {
    const { push, showNotification } = loadServiceWorker([
      { url: "https://app.example.com/messages/chat-2", focused: true },
    ]);
    await deliver(push, chatPush);
    expect(showNotification).toHaveBeenCalledWith("John", expect.objectContaining({
      data: { url: "/messages/chat-1#comment-c9" },
    }));
  });

  it("shows the alert when the chat is open but not focused", async () => {
    const { push, showNotification } = loadServiceWorker([
      { url: "https://app.example.com/messages/chat-1", focused: false },
    ]);
    await deliver(push, chatPush);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
