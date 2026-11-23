/**
 * Telegram long-poll delivery (GRE-6102).
 *
 * Telegram can only push webhooks to a public HTTPS origin. A laptop on home
 * Wi-Fi has none, so without this path its bot never receives a message. The
 * poller pulls updates with `getUpdates` over outbound HTTPS and hands each
 * one to the same authenticated inbound path a webhook would use.
 *
 * Delivery is at-least-once: an update is confirmed to Telegram (by asking
 * for `offset = update_id + 1`) only after GSAM accepted it. A crash between
 * acceptance and confirmation replays that update, which the delivery ledger
 * deduplicates. Nothing is confirmed before it is accepted, so nothing is lost.
 */

const TELEGRAM_WEBHOOK_PORTS = new Set(["", "80", "88", "443", "8443"]);

export function isSupportedTelegramWebhookBaseUrl(
  value: string | null,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TELEGRAM_WEBHOOK_PORTS.has(url.port);
  } catch {
    return false;
  }
}

/**
 * Telegram can push only to a public HTTPS origin. An explicit
 * GSAM_CHAT_WEBHOOK_PUBLIC_URL, or a board URL Telegram accepts, keeps webhook
 * mode exactly as before. Anything else (a laptop on localhost or plain HTTP)
 * pulls updates with getUpdates over outbound HTTPS instead.
 */
export function telegramDeliveryMode(input: {
  configuredWebhookPublicBaseUrl?: string | null;
  publicBaseUrl?: string | null;
}): "webhook" | "long_poll" {
  if (input.configuredWebhookPublicBaseUrl) return "webhook";
  return isSupportedTelegramWebhookBaseUrl(input.publicBaseUrl ?? null)
    ? "webhook"
    : "long_poll";
}

/** Same subscription the webhook registers, so both modes see the same events. */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "stopped_message_generation",
  "message_reaction",
  "my_chat_member",
] as const;

/** Seconds Telegram holds an empty `getUpdates` open. */
export const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_LONG_POLL_REQUEST_GRACE_MS = 10_000;
const TELEGRAM_LONG_POLL_RETRY_BASE_MS = 1_000;
const TELEGRAM_LONG_POLL_MAX_BACKOFF_MS = 60_000;
/** A single update that keeps failing must not stall the bot forever. */
const TELEGRAM_LONG_POLL_MAX_DELIVERY_ATTEMPTS = 5;
/** Failures in a row before the board is told polling is unhealthy. */
export const TELEGRAM_LONG_POLL_REPORT_AFTER_FAILURES = 3;
/**
 * Telegram picks a random next update_id after a week with no updates. A
 * stored offset older than that may be above the new ids and would silently
 * confirm (drop) them, so it is ignored and Telegram's own confirmed position
 * is used instead. Replays from that are deduplicated.
 */
export const TELEGRAM_LONG_POLL_OFFSET_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

export type TelegramPollOffset = { offset: number; savedAt: string };

export type TelegramUpdate = Record<string, unknown> & { update_id: number };

/**
 * - `accepted`: GSAM durably took the update; confirm it.
 * - `retry`: transient failure; do not confirm, try again after backoff.
 * - `stop`: the endpoint is gone or no longer eligible; end this poller.
 */
export type TelegramPollDeliveryOutcome = "accepted" | "retry" | "stop";

export interface TelegramLongPollOptions {
  botToken: string;
  fetch: typeof globalThis.fetch;
  loadOffset(): Promise<TelegramPollOffset | null>;
  saveOffset(offset: TelegramPollOffset): Promise<void>;
  deliver(update: TelegramUpdate): Promise<TelegramPollDeliveryOutcome>;
  /** Called with a token-free message as failures accumulate, and with null on recovery. */
  onHealth?(failure: { consecutiveFailures: number; message: string } | null): void;
  logger: {
    warn(details: Record<string, unknown>, message: string): void;
  };
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutSeconds?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  maxDeliveryAttempts?: number;
}

export interface TelegramLongPoller {
  /** Stops polling and resolves once the loop has exited. Safe to call twice. */
  stop(): Promise<void>;
  /** Resolves when the loop exits, for any reason. */
  readonly done: Promise<void>;
}

class TelegramPollError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export function telegramLongPollBackoffMs(
  consecutiveFailures: number,
  baseMs = TELEGRAM_LONG_POLL_RETRY_BASE_MS,
  maxMs = TELEGRAM_LONG_POLL_MAX_BACKOFF_MS,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 30));
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

export function usableTelegramPollOffset(
  stored: TelegramPollOffset | null,
  nowMs: number,
): number | undefined {
  if (!stored || !Number.isSafeInteger(stored.offset) || stored.offset < 0)
    return undefined;
  const savedAt = Date.parse(stored.savedAt);
  if (!Number.isFinite(savedAt)) return undefined;
  if (nowMs - savedAt > TELEGRAM_LONG_POLL_OFFSET_MAX_AGE_MS) return undefined;
  return stored.offset;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as { update_id?: unknown }).update_id) &&
    (value as { update_id: number }).update_id >= 0
  );
}

export function startTelegramLongPoll(
  options: TelegramLongPollOptions,
): TelegramLongPoller {
  const controller = new AbortController();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const timeoutSeconds =
    options.timeoutSeconds ?? TELEGRAM_LONG_POLL_TIMEOUT_SECONDS;
  const maxDeliveryAttempts =
    options.maxDeliveryAttempts ?? TELEGRAM_LONG_POLL_MAX_DELIVERY_ATTEMPTS;

  // Never put the URL (it carries the bot token) or transport prose in an
  // error: only the method, HTTP status, and Telegram's own description.
  async function call(
    method: "deleteWebhook" | "getUpdates",
    body: Record<string, unknown>,
    requestTimeoutMs: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await options.fetch(
        `https://api.telegram.org/bot${encodeURIComponent(options.botToken)}/${method}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(requestTimeoutMs),
          ]),
        },
      );
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new TelegramPollError(
        `Telegram ${method} could not reach Telegram`,
        null,
      );
    }
    let payload: {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      parameters?: { retry_after?: unknown };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new TelegramPollError(
        `Telegram ${method} returned an invalid response (${response.status})`,
        response.status,
      );
    }
    if (!response.ok || payload.ok !== true) {
      const description =
        typeof payload.description === "string"
          ? payload.description.slice(0, 200)
          : String(response.status);
      const retryAfter = payload.parameters?.retry_after;
      throw new TelegramPollError(
        `Telegram ${method} failed: ${description}`,
        response.status,
        typeof retryAfter === "number" && retryAfter > 0
          ? retryAfter * 1000
          : null,
      );
    }
    return payload.result;
  }

  async function loop(): Promise<void> {
    let webhookCleared = false;
    let offsetLoaded = false;
    let offset: number | undefined;
    let lastConfirmedAt = now();
    let consecutiveFailures = 0;
    let reportedFailure = false;
    const attempts = new Map<number, number>();

    const confirm = async (updateId: number) => {
      offset = updateId + 1;
      lastConfirmedAt = now();
      attempts.delete(updateId);
      await options.saveOffset({
        offset,
        savedAt: new Date(lastConfirmedAt).toISOString(),
      });
    };

    while (!controller.signal.aborted) {
      try {
        if (!webhookCleared) {
          // Telegram refuses getUpdates while a webhook is registered. Keep
          // the backlog: those updates are real messages waiting for us.
          await call(
            "deleteWebhook",
            { drop_pending_updates: false },
            TELEGRAM_LONG_POLL_REQUEST_GRACE_MS,
          );
          webhookCleared = true;
        }
        if (!offsetLoaded) {
          offset = usableTelegramPollOffset(await options.loadOffset(), now());
          offsetLoaded = true;
        } else if (
          offset !== undefined &&
          now() - lastConfirmedAt > TELEGRAM_LONG_POLL_OFFSET_MAX_AGE_MS
        ) {
          offset = undefined;
        }
        const result = await call(
          "getUpdates",
          {
            ...(offset === undefined ? {} : { offset }),
            timeout: timeoutSeconds,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          },
          timeoutSeconds * 1000 + TELEGRAM_LONG_POLL_REQUEST_GRACE_MS,
        );
        const updates = (Array.isArray(result) ? result : [])
          .filter(isTelegramUpdate)
          .sort((a, b) => a.update_id - b.update_id);
        for (const update of updates) {
          if (controller.signal.aborted) return;
          const outcome = await options
            .deliver(update)
            .catch((): TelegramPollDeliveryOutcome => "retry");
          if (outcome === "stop") return;
          if (outcome === "retry") {
            const tries = (attempts.get(update.update_id) ?? 0) + 1;
            if (tries < maxDeliveryAttempts) {
              attempts.set(update.update_id, tries);
              throw new TelegramPollError(
                `Telegram update could not be accepted (attempt ${tries} of ${maxDeliveryAttempts})`,
                null,
              );
            }
            // Bounded: Telegram drops a webhook update after its own retries
            // too. Skipping keeps every later message flowing.
            options.logger.warn(
              { updateId: update.update_id, attempts: tries },
              "Telegram long-poll skipped an update GSAM could not accept",
            );
          }
          await confirm(update.update_id);
        }
        consecutiveFailures = 0;
        if (reportedFailure) {
          reportedFailure = false;
          options.onHealth?.(null);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure =
          error instanceof TelegramPollError
            ? error
            : new TelegramPollError(
                "Telegram long-poll failed unexpectedly",
                null,
              );
        // 409: a webhook was (re)registered, or another poller holds the bot.
        if (failure.status === 409) webhookCleared = false;
        consecutiveFailures += 1;
        const delayMs = Math.max(
          failure.retryAfterMs ?? 0,
          telegramLongPollBackoffMs(
            consecutiveFailures,
            options.retryBaseMs,
            options.maxBackoffMs,
          ),
        );
        options.logger.warn(
          {
            consecutiveFailures,
            retryDelayMs: delayMs,
            status: failure.status,
            error: failure.message,
          },
          "Telegram long-poll request failed",
        );
        if (consecutiveFailures >= TELEGRAM_LONG_POLL_REPORT_AFTER_FAILURES) {
          reportedFailure = true;
          options.onHealth?.({
            consecutiveFailures,
            message: failure.message,
          });
        }
        await sleep(delayMs, controller.signal);
      }
    }
  }

  const done = loop().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    options.logger.warn(
      {
        error:
          error instanceof TelegramPollError
            ? error.message
            : "Telegram long-poll stopped unexpectedly",
      },
      "Telegram long-poll stopped",
    );
  });
  return {
    done,
    async stop() {
      controller.abort();
      await done;
    },
  };
}
