import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  disableTelegramRichOutbound,
} from "./chat-sdk-runtime.js";
import { safeMilestoneText } from "./chat-run-publications.js";
import type { ChatSdkStatePersistence } from "./chat-sdk-state.js";

// GRE-327: a Telegram user must never get a blank reply. Telegram accepted
// `sendRichMessage` and returned a message ID, but the user's client showed an
// empty bubble. Terminal text must go out as regular, non-empty message text.

const persistence: ChatSdkStatePersistence = {
  async compareAndSet() {
    return true;
  },
  async deleteIfVersion() {
    return true;
  },
  async read() {
    return null;
  },
};

type TelegramCall = { method: string; body: Record<string, unknown> };

function telegramRuntime(calls: TelegramCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.split("/").at(-1)!;
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({
        ok: true,
        result: {
          message_id: 40 + calls.length,
          date: 1_790_869_422,
          chat: { id: 8041225926, type: "private" },
        },
      });
    }),
  );
  return createChatSdkEndpointRuntime({
    callbacks: { onMessage() {} },
    companyId: "company-gre-327",
    endpointId: "endpoint-gre-327",
    logger: "silent",
    persistence,
    providerConfig: {
      provider: "telegram",
      userName: "GS_Everest_bot",
      credentials: {
        botToken: "123:test",
        secretToken: "telegram-webhook-secret",
      },
    },
  });
}

type TelegramTestAdapter = {
  postMessage(
    threadId: string,
    message: { markdown: string },
  ): Promise<{ id: string }>;
  editMessage(
    threadId: string,
    messageId: string,
    message: { markdown: string },
  ): Promise<{ id: string }>;
};

function sentText(call: TelegramCall | undefined): string {
  expect(call?.body.rich_message).toBeUndefined();
  const text = call?.body.text;
  expect(typeof text).toBe("string");
  expect((text as string).trim().length).toBeGreaterThan(0);
  return text as string;
}

describe("Telegram terminal replies are never blank (GRE-327)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finalises a refused unlinked-guest run with text that names the fix", async () => {
    const refusal = safeMilestoneText({
      agentName: "Everest",
      errorCode: "low_trust_requires_sandbox_environment",
      milestone: "failed",
      issueId: "issue-gre-324",
      provider: "telegram",
      publicBaseUrl: null,
    });
    expect(refusal).toContain(
      "Apps → Telegram → Access → Identity links",
    );

    const calls: TelegramCall[] = [];
    const runtime = telegramRuntime(calls);
    try {
      const adapter = runtime.getProviderAdapter() as unknown as TelegramTestAdapter;
      // The run is refused before any placeholder exists: a fresh send.
      await adapter.postMessage("telegram:8041225926", { markdown: refusal });
      expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
      expect(sentText(calls[0])).toContain("Identity links");
    } finally {
      await runtime.shutdown();
    }
  });

  it("edits the working placeholder into non-empty failure text when the run fails", async () => {
    const calls: TelegramCall[] = [];
    const runtime = telegramRuntime(calls);
    try {
      const adapter = runtime.getProviderAdapter() as unknown as TelegramTestAdapter;
      const placeholder = await adapter.postMessage("telegram:8041225926", {
        markdown: safeMilestoneText({
          agentName: "Everest",
          milestone: "working",
          issueId: "issue-gre-324",
        }),
      });
      await adapter.editMessage("telegram:8041225926", placeholder.id, {
        markdown: safeMilestoneText({
          agentName: "Everest",
          errorCode: "adapter_failed",
          milestone: "failed",
          issueId: "issue-gre-324",
          provider: "telegram",
          publicBaseUrl: null,
        }),
      });
      expect(calls.map((call) => call.method)).toEqual([
        "sendMessage",
        "editMessageText",
      ]);
      expect(sentText(calls[0])).toContain("Everest is working");
      const failure = sentText(calls[1]);
      expect(failure).toContain("Everest stopped before completing this turn");
      expect(failure).toContain("Open the task in GS Agentic Manager");
    } finally {
      await runtime.shutdown();
    }
  });

  it("delivers a linked user's normal formatted answer as visible text", async () => {
    // GRE-326: the agent's real answer edited the placeholder via rich_message
    // and also never showed in Telegram.
    const calls: TelegramCall[] = [];
    const runtime = telegramRuntime(calls);
    try {
      const adapter = runtime.getProviderAdapter() as unknown as TelegramTestAdapter;
      const placeholder = await adapter.postMessage("telegram:8041225926", {
        markdown: "Everest is working…",
      });
      await adapter.editMessage("telegram:8041225926", placeholder.id, {
        markdown:
          "I got your message, so the Telegram link to me works.\n\n- **This chat:** send me a task",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "sendMessage",
        "editMessageText",
      ]);
      expect(sentText(calls[1])).toContain("Telegram link to me works");
    } finally {
      await runtime.shutdown();
    }
  });

  it("fails closed if a future adapter drops the rich-message flag", () => {
    expect(() => disableTelegramRichOutbound({})).toThrow(
      "Telegram rich-message output contract is unavailable",
    );
    const adapter = { richMessagesAvailable: true };
    disableTelegramRichOutbound(adapter);
    expect(adapter.richMessagesAvailable).toBe(false);
  });
});
