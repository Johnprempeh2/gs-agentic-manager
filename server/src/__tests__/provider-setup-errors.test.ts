import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  providerFailureHttpStatus,
  providerSetupJson,
  providerStep,
  providerStepError,
  sanitizeProviderText,
} from "../services/provider-setup-errors.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("provider setup errors", () => {
  it("maps provider refusals to 4xx and outages to 502, never 500", () => {
    expect(providerFailureHttpStatus(401)).toBe(400);
    for (const status of [402, 403, 404, 409, 422, 429])
      expect(providerFailureHttpStatus(status)).toBe(status);
    expect(providerFailureHttpStatus(400)).toBe(400);
    expect(providerFailureHttpStatus(500)).toBe(502);
    expect(providerFailureHttpStatus(503)).toBe(502);
  });

  it("names the provider, step, status and next action", () => {
    const error = providerStepError({
      provider: "Slack",
      step: "verify the bot token",
      status: 403,
      providerCode: "not_allowed_token_type",
    });
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Slack refused to verify the bot token (403: not_allowed_token_type). The credential does not have permission for this step; check its scopes or permissions in Slack.",
    );
    expect(error.details).toMatchObject({
      code: "provider_setup_refused",
      provider: "Slack",
      step: "verify the bot token",
      providerStatus: 403,
    });
  });

  it("sanitises provider text: secrets, token shapes, control characters and length", () => {
    const secret = "1234567:AAH-telegram-bot-token-value-abcdef";
    const text = sanitizeProviderText(
      `bad token ${secret}\u0007 xoxb-1234-5678-abcdefgh Bearer abc.def ${"y ".repeat(300)}`,
      [secret],
    )!;
    expect(text).not.toContain(secret);
    expect(text).not.toContain("xoxb-1234");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("\u0007");
    expect(text.length).toBeLessThanOrEqual(240);
    expect(sanitizeProviderText(undefined)).toBeUndefined();
    expect(sanitizeProviderText("   ")).toBeUndefined();
  });

  // The Slack, Telegram, GitHub and Microsoft Teams credential checks in
  // chat-channels.ts use providerSetupJson with these provider/step names.
  it("Slack credential check: a 503 HTML page becomes a step-named 502, not a JSON parse crash", async () => {
    const error = await providerSetupJson("Slack", "verify the bot token", async () =>
      new Response("<html>Service Unavailable</html>", { status: 503 }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 502,
      message: "Slack could not verify the bot token (503). Slack had a problem; try again shortly.",
    });
  });

  it("Telegram credential check: rate limiting stays a 429 and refusals are returned to the caller", async () => {
    await expect(
      providerSetupJson("Telegram", "verify the bot token", async () =>
        json({ ok: false, description: "Too Many Requests" }, 429),
      ),
    ).rejects.toMatchObject({ status: 429 });
    const refused = await providerSetupJson<{ ok?: boolean; description?: string }>(
      "Telegram",
      "verify the bot token",
      async () => json({ ok: false, description: "Unauthorized" }, 401),
    );
    expect(refused.response.status).toBe(401);
    expect(refused.body.description).toBe("Unauthorized");
  });

  it("an unreadable success body or a network failure becomes a step-named 502", async () => {
    await expect(
      providerSetupJson("GitHub", "verify the app credentials", async () =>
        new Response("not json", { status: 200 }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: "Could not verify the app credentials with GitHub: the response could not be read. Check the network connection and try again.",
    });
    await expect(
      providerSetupJson("Microsoft", "verify the app credentials", () =>
        Promise.reject(new TypeError("fetch failed")),
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: "Could not verify the app credentials with Microsoft: the provider could not be reached. Check the network connection and try again.",
    });
  });

  it("passes HttpErrors and unrelated errors through unchanged", async () => {
    const http = new HttpError(409, "already running");
    await expect(providerStep("X", "do it", () => Promise.reject(http))).rejects.toBe(http);
    const bug = new RangeError("bug");
    await expect(providerStep("X", "do it", () => Promise.reject(bug))).rejects.toBe(bug);
    const mapper = vi.fn(() => undefined);
    await expect(providerStep("X", "do it", () => Promise.reject(bug), mapper)).rejects.toBe(bug);
    expect(mapper).toHaveBeenCalledWith(bug);
  });
});
