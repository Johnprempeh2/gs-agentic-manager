import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type PushListener = (event: {
  data: { json: () => unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

type ClickListener = (event: {
  action: string;
  notification: { close: () => void; data: unknown };
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
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    registration: { showNotification },
    location: { origin: "https://app.example.com" },
  };
  const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8")
    .replace("__GSAM_BUILD_ID__", "fixture-production");
  const fetchMock = vi.fn(async () => new Response("{}"));
  new Function("self", "caches", "fetch", "Response", "URL", code)(swSelf, {}, fetchMock, Response, URL);
  const listener = listeners.get("push");
  if (!listener) throw new Error("sw.js registered no push listener");
  const click = listeners.get("notificationclick") as ClickListener | undefined;
  if (!click) throw new Error("sw.js registered no notificationclick listener");
  return { push: listener as PushListener, click, showNotification, fetchMock, openWindow: swSelf.clients.openWindow };
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

async function tap(click: ClickListener, action: string, data: unknown) {
  let pending: Promise<unknown> | undefined;
  click({ action, notification: { close: () => {}, data }, waitUntil: (promise) => { pending = promise; } });
  await pending;
}

describe("sw.js pause for an hour", () => {
  it("offers the button only when the push names a company", async () => {
    const { push, showNotification } = loadServiceWorker([]);
    await deliver(push, { title: "Deal won", body: "Indago", url: "/PSH/today", tag: "deal:c1", companyId: "co-1" });
    await deliver(push, { title: "Test", body: "Hi", url: "/PSH/today", tag: "push-test" });
    expect(showNotification).toHaveBeenNthCalledWith(1, "Deal won", expect.objectContaining({
      data: { url: "/PSH/today", companyId: "co-1" },
      actions: [{ action: "pause-hour", title: "Pause for an hour" }],
    }));
    const second = (showNotification.mock.calls[1] as unknown[] | undefined)?.[1] as Record<string, unknown>;
    expect(second.actions).toBeUndefined();
    expect(second.data).toEqual({ url: "/PSH/today" });
  });

  it("pauses that company's notifications for an hour without opening the app", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T02:00:00Z"));
    try {
      const { click, fetchMock, openWindow } = loadServiceWorker([]);
      await tap(click, "pause-hour", { url: "/PSH/today", companyId: "co-1" });
      expect(fetchMock).toHaveBeenCalledWith("/api/companies/co-1/notification-preferences", expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({ pausedUntil: "2026-10-18T03:00:00.000Z" }),
      }));
      expect(openWindow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the pause did not save", async () => {
    const { click, fetchMock, showNotification } = loadServiceWorker([]);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await tap(click, "pause-hour", { url: "/PSH/today", companyId: "co-1" });
    expect(showNotification).toHaveBeenCalledWith("Notifications were not paused", expect.objectContaining({ tag: "pause-failed" }));
  });

  it("still opens the notification's page on a plain tap", async () => {
    const { click, fetchMock, openWindow } = loadServiceWorker([]);
    await tap(click, "", { url: "/PSH/today", companyId: "co-1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith("https://app.example.com/PSH/today");
  });
});
