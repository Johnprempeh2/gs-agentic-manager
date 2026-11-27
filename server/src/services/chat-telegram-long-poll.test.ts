import { describe, expect, it, vi } from "vitest";
import {
  startTelegramLongPoll,
  telegramDeliveryMode,
  telegramLongPollBackoffMs,
  usableTelegramPollOffset,
  TELEGRAM_LONG_POLL_OFFSET_MAX_AGE_MS,
  type TelegramPollDeliveryOutcome,
  type TelegramPollOffset,
  type TelegramUpdate,
} from "./chat-telegram-long-poll.js";

const BOT_TOKEN = "123456789:AAH-telegram-long-poll-canary-token";
const NOW = Date.parse("2026-11-24T10:00:00.000Z");

type Reply =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; status: number; description: string; retryAfter?: number }
  | { kind: "network" };

/**
 * Scripted Telegram: each call takes the next reply for its method. When a
 * method runs out of replies the call hangs until the poller aborts it, the
 * way a real long poll waits for messages.
 */
function fakeTelegram(script: { deleteWebhook?: Reply[]; getUpdates: Reply[] }) {
  const calls: Array<{ method: string; body: Record<string, unknown>; url: string }> = [];
  const queues: Record<string, Reply[]> = {
    deleteWebhook: [...(script.deleteWebhook ?? [])],
    getUpdates: [...script.getUpdates],
  };
  let idle: () => void = () => {};
  const idleReached = new Promise<void>((resolve) => {
    idle = resolve;
  });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")), url });
    const reply =
      queues[method]!.shift() ??
      (method === "deleteWebhook" ? ({ kind: "ok", result: true } as Reply) : undefined);
    if (!reply) {
      idle();
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
          once: true,
        });
      });
    }
    if (reply.kind === "network")
      throw new TypeError(`fetch failed for ${url}`);
    if (reply.kind === "error")
      return Response.json(
        {
          ok: false,
          description: reply.description,
          ...(reply.retryAfter ? { parameters: { retry_after: reply.retryAfter } } : {}),
        },
        { status: reply.status },
      );
    return Response.json({ ok: true, result: reply.result });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, idleReached };
}

function update(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: 1, type: "private" }, text: `m${updateId}` },
  };
}

function harness(options: {
  telegram: ReturnType<typeof fakeTelegram>;
  stored?: TelegramPollOffset | null;
  deliver?: (update: TelegramUpdate) => Promise<TelegramPollDeliveryOutcome>;
}) {
  const saved: TelegramPollOffset[] = [];
  const delivered: number[] = [];
  const sleeps: number[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const health: Array<{ consecutiveFailures: number; message: string } | null> = [];
  const poller = startTelegramLongPoll({
    botToken: BOT_TOKEN,
    fetch: options.telegram.fetch,
    loadOffset: async () => options.stored ?? null,
    saveOffset: async (offset) => {
      saved.push(offset);
    },
    deliver: async (value) => {
      delivered.push(value.update_id);
      return options.deliver ? options.deliver(value) : "accepted";
    },
    onHealth: (value) => health.push(value),
    logger: { warn: (details) => warnings.push(details) },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { poller, saved, delivered, sleeps, warnings, health };
}

describe("Telegram delivery mode", () => {
  it.each([
    // An explicit ingress always keeps webhook mode, as before.
    [{ configuredWebhookPublicBaseUrl: "https://hooks.example.com" }, "webhook"],
    [
      {
        configuredWebhookPublicBaseUrl: "https://hooks.example.com:10000",
        publicBaseUrl: "http://localhost:3100",
      },
      "webhook",
    ],
    // No explicit ingress: a board URL Telegram accepts keeps webhook mode.
    [{ publicBaseUrl: "https://gsam.example.com" }, "webhook"],
    [{ publicBaseUrl: "https://gsam.example.com:8443" }, "webhook"],
    // A laptop: nothing public, plain HTTP, or a port Telegram refuses.
    [{}, "long_poll"],
    [{ publicBaseUrl: null }, "long_poll"],
    [{ publicBaseUrl: "http://localhost:3100" }, "long_poll"],
    [{ publicBaseUrl: "https://will-mac.local:3100" }, "long_poll"],
  ] as const)("%o -> %s", (input, expected) => {
    expect(telegramDeliveryMode(input)).toBe(expected);
  });
});

describe("Telegram long-poll delivery", () => {
  it("clears any webhook without dropping the backlog before it polls", async () => {
    const telegram = fakeTelegram({ getUpdates: [] });
    const { poller } = harness({ telegram });
    await telegram.idleReached;
    await poller.stop();

    expect(telegram.calls.map((call) => call.method)).toEqual([
      "deleteWebhook",
      "getUpdates",
    ]);
    expect(telegram.calls[0]!.body).toEqual({ drop_pending_updates: false });
    expect(telegram.calls[1]!.body).toMatchObject({
      timeout: 25,
      allowed_updates: expect.arrayContaining(["message", "callback_query"]),
    });
  });

  it("resumes from the stored offset and saves the next one after each accepted update", async () => {
    const telegram = fakeTelegram({
      getUpdates: [{ kind: "ok", result: [update(42), update(41)] }],
    });
    const { poller, saved, delivered } = harness({
      telegram,
      stored: { offset: 41, savedAt: new Date(NOW - 60_000).toISOString() },
    });
    await telegram.idleReached;
    await poller.stop();

    expect(telegram.calls[1]!.body.offset).toBe(41);
    expect(delivered).toEqual([41, 42]);
    expect(saved.map((value) => value.offset)).toEqual([42, 43]);
    // The next poll confirms both updates to Telegram.
    expect(telegram.calls[2]!.body.offset).toBe(43);
  });

  it("ignores a stored offset older than Telegram's update-id reset window", () => {
    const stale = {
      offset: 900,
      savedAt: new Date(NOW - TELEGRAM_LONG_POLL_OFFSET_MAX_AGE_MS - 1).toISOString(),
    };
    expect(usableTelegramPollOffset(stale, NOW)).toBeUndefined();
    expect(usableTelegramPollOffset({ ...stale, savedAt: new Date(NOW).toISOString() }, NOW)).toBe(900);
    expect(usableTelegramPollOffset({ offset: -1, savedAt: new Date(NOW).toISOString() }, NOW)).toBeUndefined();
    expect(usableTelegramPollOffset(null, NOW)).toBeUndefined();
  });

  it("does not confirm an update GSAM failed to accept, and redelivers it after backoff", async () => {
    const telegram = fakeTelegram({
      getUpdates: [
        { kind: "ok", result: [update(7), update(8)] },
        { kind: "ok", result: [update(8)] },
      ],
    });
    let failOnce = true;
    const { poller, saved, delivered, sleeps } = harness({
      telegram,
      deliver: async (value) => {
        if (value.update_id === 8 && failOnce) {
          failOnce = false;
          return "retry";
        }
        return "accepted";
      },
    });
    await telegram.idleReached;
    await poller.stop();

    expect(delivered).toEqual([7, 8, 8]);
    expect(saved.map((value) => value.offset)).toEqual([8, 9]);
    expect(telegram.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset)).toEqual([
      undefined,
      8,
      9,
    ]);
    expect(sleeps).toEqual([1_000]);
  });

  it("skips one update after bounded attempts so later messages keep flowing", async () => {
    const telegram = fakeTelegram({
      getUpdates: Array.from({ length: 5 }, () => ({ kind: "ok", result: [update(5)] }) as Reply),
    });
    const { poller, saved, delivered, warnings } = harness({
      telegram,
      deliver: async () => "retry",
    });
    await telegram.idleReached;
    await poller.stop();

    expect(delivered).toEqual([5, 5, 5, 5, 5]);
    expect(saved.map((value) => value.offset)).toEqual([6]);
    expect(warnings.some((w) => w.updateId === 5 && w.attempts === 5)).toBe(true);
  });

  it("backs off exponentially on network errors, caps the delay, and never logs the token", async () => {
    expect([1, 2, 3, 4, 7, 50].map((n) => telegramLongPollBackoffMs(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000,
    ]);
    const telegram = fakeTelegram({
      getUpdates: [
        { kind: "network" },
        { kind: "network" },
        { kind: "network" },
        { kind: "error", status: 429, description: "Too Many Requests", retryAfter: 9 },
        { kind: "ok", result: [] },
      ],
    });
    const { poller, sleeps, warnings, health } = harness({ telegram });
    await telegram.idleReached;
    await poller.stop();

    expect(sleeps).toEqual([1_000, 2_000, 4_000, 9_000]);
    expect(JSON.stringify(warnings)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(warnings)).not.toContain("123456789");
    expect(JSON.stringify(health)).not.toContain(BOT_TOKEN);
    // Reported once failures persist, then cleared when polling recovers.
    expect(health.at(-1)).toBeNull();
    expect(health.filter(Boolean)[0]).toMatchObject({ consecutiveFailures: 3 });
  });

  it("clears the webhook again when Telegram reports a conflict", async () => {
    const telegram = fakeTelegram({
      getUpdates: [
        {
          kind: "error",
          status: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        },
      ],
    });
    const { poller } = harness({ telegram });
    await telegram.idleReached;
    await poller.stop();

    expect(telegram.calls.map((call) => call.method)).toEqual([
      "deleteWebhook",
      "getUpdates",
      "deleteWebhook",
      "getUpdates",
    ]);
  });

  it("stops an in-flight long poll promptly and only once", async () => {
    const telegram = fakeTelegram({ getUpdates: [] });
    const { poller } = harness({ telegram });
    await telegram.idleReached;
    await Promise.all([poller.stop(), poller.stop()]);
    await expect(poller.done).resolves.toBeUndefined();
    const callsAfterStop = telegram.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telegram.calls).toHaveLength(callsAfterStop);
  });

  it("ends the loop when the endpoint is no longer eligible", async () => {
    const telegram = fakeTelegram({
      getUpdates: [{ kind: "ok", result: [update(3), update(4)] }],
    });
    const { poller, delivered, saved } = harness({
      telegram,
      deliver: async () => "stop",
    });
    await poller.done;

    expect(delivered).toEqual([3]);
    expect(saved).toEqual([]);
    expect(telegram.calls.filter((c) => c.method === "getUpdates")).toHaveLength(1);
  });
});
