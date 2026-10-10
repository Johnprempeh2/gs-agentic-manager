import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import type { HttpError } from "../errors.js";
import {
  agentmailApi,
  AgentmailApiError,
  agentmailPathTemplate,
  agentmailStep,
  agentmailMessageSchema,
  emailText,
  emailReplyRecipients,
  isAutomaticEmail,
  isFilteredEmail,
  isSenderAuthenticated,
  normalizeAgentmailEvent,
  verifyAgentmailWebhook,
} from "../services/agentmail-api.js";
import { emailSendSchema } from "@greatstone/shared";
import { buildRunnerApiCatalog } from "../services/native-runtime/runner-api-catalog.js";

const message = (extra = {}) =>
  agentmailMessageSchema.parse({
    inbox_id: "agent@agentmail.to",
    thread_id: "thread",
    message_id: "message",
    timestamp: new Date().toISOString(),
    ...extra,
  });
describe("AgentMail protocol boundary", () => {
  it("verifies the exact raw body and rejects forged or stale Svix signatures", () => {
    const secret = `whsec_${Buffer.from("a-test-secret-only").toString("base64")}`;
    const body = JSON.stringify({
      event_type: "message.received",
      message: message(),
    });
    const timestamp = new Date();
    const id = randomUUID();
    const headers = {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, timestamp, body),
    };
    expect(verifyAgentmailWebhook(Buffer.from(body), headers, secret)).toEqual(
      JSON.parse(body),
    );
    expect(() =>
      verifyAgentmailWebhook(Buffer.from(body + " "), headers, secret),
    ).toThrow();
    expect(() =>
      verifyAgentmailWebhook(
        Buffer.from(body),
        { ...headers, "svix-timestamp": "1" },
        secret,
      ),
    ).toThrow();
  });
  it("normalizes both transports and keeps delivery receipts separate from incoming mail", () => {
    const m = { inbox_id: "inbox", message_id: "message" };
    expect(
      normalizeAgentmailEvent({ event_type: "message.received", message: m })
        ?.kind,
    ).toBe("message.received");
    expect(
      normalizeAgentmailEvent({ type: "message_received", message: m })?.kind,
    ).toBe("message.received");
    expect(
      normalizeAgentmailEvent({ type: "message_delivered", message: m })?.kind,
    ).toBe("message.delivered");
    expect(normalizeAgentmailEvent({ type: "subscribed" })).toBeNull();
    expect(() =>
      normalizeAgentmailEvent({ event_type: "message.received", message: {} }),
    ).toThrow();
  });
  it.each([
    ["message.sent", "send"],
    ["message.delivered", "delivery"],
    ["message.bounced", "bounce"],
    ["message.complained", "complaint"],
    ["message.rejected", "reject"],
  ])("admits the documented %s receipt envelope through either transport", (kind, field) => {
    for (const transport of [{ type: "event", event_type: kind }, { type: kind.replace(".", "_") }]) {
      expect(normalizeAgentmailEvent({
        ...transport,
        event_id: "provider-event",
        [field]: { inbox_id: "inbox", thread_id: "thread", message_id: "sent-message" },
      })).toEqual({ kind, inbox_id: "inbox", message_id: "sent-message", eventId: "provider-event" });
    }
  });
  it("prefers extracted text, strips HTML and recognizes provider filtering and auto-replies", () => {
    expect(
      emailText(
        message({ extracted_text: "New reply", text: "Quoted history" }),
      ),
    ).toBe("New reply");
    expect(
      emailText(
        message({
          html: '<script>alert(1)</script><img src="https://tracking.test"><p>Hello</p>',
        }),
      ),
    ).not.toContain("tracking.test");
    expect(
      isAutomaticEmail(
        message({ headers: { "Auto-Submitted": "auto-replied" } }),
      ),
    ).toBe(true);
    expect(
      isAutomaticEmail(message({ headers: { "Auto-Submitted": "no" } })),
    ).toBe(false);
    for (const label of ["spam", "blocked", "unauthenticated"])
      expect(isFilteredEmail(message({ labels: [label] }))).toBe(true);
  });
  it("trusts only AgentMail's DMARC verdict for the sender, never a planted header (GRE-1215)", () => {
    expect(
      isSenderAuthenticated(
        message({ authentication_results: { spf: "pass", dkim: "pass", dmarc: "pass" } }),
      ),
    ).toBe(true);
    // An unaligned SPF pass, no DMARC record: AgentMail adds no label, but the From is unproven.
    expect(
      isSenderAuthenticated(message({ authentication_results: { dmarc: "none" } })),
    ).toBe(false);
    expect(isSenderAuthenticated(message({ authentication_results: {} }))).toBe(false);
    expect(
      isSenderAuthenticated(
        message({
          headers: {
            "Authentication-Results": "mx.example; spf=pass; dkim=pass; dmarc=pass",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSenderAuthenticated(
        message({ authentication_results: { dmarc: "some-future-verdict" } }),
      ),
    ).toBe(false);
  });
  it("pins the API host, encodes message IDs and preserves the provider idempotency key", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message_id: "sent", thread_id: "thread" }),
        ),
      );
    await agentmailApi("private-key", fetcher).send(
      "agent@agentmail.to",
      { text: "Reply", reply_all: false },
      "stable-key",
      "<message@domain>",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.agentmail.to/v0/inboxes/agent%40agentmail.to/messages/%3Cmessage%40domain%3E/reply",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "Idempotency-Key": "stable-key" }),
      }),
    );
  });
  it("redacts provider error bodies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("private email and credentials", { status: 403 }),
      );
    const error = await agentmailApi("private-key", fetcher)
      .whoami()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentmailApiError);
    expect((error as Error).message).toBe(
      "AgentMail request failed (403) on GET /auth/me",
    );
    expect(error).toMatchObject({ providerCode: undefined, providerMessage: undefined });
  });
  it("keeps the method, an id-free path template and the sanitised provider code and message", async () => {
    const apiKey = "am_live_secret_value_123456";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "AuthorizationError",
          code: "missing_permission",
          message: `Key ${apiKey} lacks api_key_create\u0000 ${"more detail ".repeat(40)}`,
          fix: "ignored",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    const error = (await agentmailApi(apiKey, fetcher)
      .createInboxKey("agent@agentmail.to")
      .catch((e: unknown) => e)) as AgentmailApiError;
    expect(error).toBeInstanceOf(AgentmailApiError);
    expect(error.status).toBe(403);
    expect(error.method).toBe("POST");
    expect(error.path).toBe("/inboxes/{id}/api-keys");
    expect(error.providerCode).toBe("missing_permission");
    expect(error.providerMessage).toMatch(/^Key \[redacted\] lacks api_key_create /);
    expect(error.providerMessage!.length).toBeLessThanOrEqual(240);
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain("agent@agentmail.to");
    expect(error.message).toContain("on POST /inboxes/{id}/api-keys: missing_permission: Key [redacted]");
  });
  it("builds path templates without identifiers", () => {
    expect(agentmailPathTemplate("/inboxes/a%40b.to/messages/%3Cm%3E/reply")).toBe(
      "/inboxes/{id}/messages/{id}/reply",
    );
    expect(agentmailPathTemplate("/inboxes/a%40b.to/messages/send")).toBe(
      "/inboxes/{id}/messages/send",
    );
    expect(agentmailPathTemplate("/inboxes?limit=100")).toBe("/inboxes");
    expect(agentmailPathTemplate("/auth/me")).toBe("/auth/me");
    expect(agentmailPathTemplate("/domains/d1")).toBe("/domains/{id}");
  });
  it("maps setup refusals to step-named 4xx errors and outages to 502", async () => {
    const refuse = (status: number, body: unknown = {}) =>
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    const run = (status: number, step: Parameters<typeof agentmailStep>[0], body?: unknown) =>
      agentmailStep(step, () =>
        agentmailApi("am_key", refuse(status, body)).createInbox({}),
      ).catch((e: unknown) => e as HttpError);
    expect(await run(401, "checkKey")).toMatchObject({ status: 400 });
    expect(await run(402, "createInbox")).toMatchObject({ status: 402 });
    const conflictError = await run(409, "createInbox", { code: "already_exists", message: "Inbox already exists" });
    expect(conflictError).toMatchObject({ status: 409 });
    expect(conflictError.message).toBe(
      "AgentMail refused to create an inbox (409: already_exists: Inbox already exists). That email address is already taken. Choose a different username.",
    );
    expect(await run(404, "readInbox")).toMatchObject({ status: 404 });
    expect(await run(422, "createInbox")).toMatchObject({ status: 422 });
    expect(await run(429, "createInbox")).toMatchObject({ status: 429 });
    expect(await run(418, "createInbox")).toMatchObject({ status: 400 });
    const outage = await run(503, "createInbox");
    expect(outage).toMatchObject({ status: 502 });
    expect(outage.message).toMatch(/^AgentMail could not create an inbox \(503\)/);
    const timeout = await agentmailStep("createInbox", () =>
      agentmailApi("am_key", vi.fn().mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }))).createInbox({}),
    ).catch((e: unknown) => e as HttpError);
    expect(timeout).toMatchObject({ status: 502, message: "Could not create an inbox with AgentMail: the request timed out. Check the network connection and try again." });
  });
  it("constructs deliberate reply-all from visible recipients, excluding self and Bcc", () => {
    const envelope = {
      from: "Sender <sender@example.test>",
      to: ["agent@agentmail.to", "visible@example.test"],
      cc: ["visible@example.test", "cc@example.test"],
      bcc: ["private@example.test"],
      subject: "Hello",
    };
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", false)).toEqual(
      { to: ["sender@example.test"], cc: [], bcc: [], reply_all: false },
    );
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", true)).toEqual({
      to: ["sender@example.test", "visible@example.test"],
      cc: ["cc@example.test"],
      bcc: [],
      reply_all: false,
    });
  });
  it("honors Reply-To for reply and reply-all without adding the forwarding sender or Bcc", () => {
    const envelope = {
      from: "Forwarder <forwarder@example.test>",
      replyTo: ["Reply desk <reply@example.test>", "agent@agentmail.to"],
      to: ["agent@agentmail.to", "visible@example.test"],
      cc: ["reply@example.test", "cc@example.test"],
      bcc: ["private@example.test"],
      subject: "Forwarded request",
    };
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", false)).toEqual({
      to: ["reply@example.test"], cc: [], bcc: [], reply_all: false,
    });
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", true)).toEqual({
      to: ["reply@example.test", "visible@example.test"], cc: ["cc@example.test"], bcc: [], reply_all: false,
    });
    expect(emailReplyRecipients({ ...envelope, replyTo: [] }, "agent@agentmail.to", false).to)
      .toEqual(["forwarder@example.test"]);
  });
  it("validates explicit new-message and reply envelopes, rejecting header injection and Bcc reuse", () => {
    const base = {
      endpointId: randomUUID(),
      idempotencyKey: randomUUID(),
      text: "Hello",
    };
    expect(
      emailSendSchema.safeParse({
        ...base,
        parentIssueId: randomUUID(),
        to: ["person@example.test"],
        subject: "Hi\r\nBcc: hidden@example.test",
      }).success,
    ).toBe(false);
    expect(
      emailSendSchema.safeParse({
        ...base,
        conversationId: randomUUID(),
        replyToMessageId: "message",
        bcc: ["hidden@example.test"],
      }).success,
    ).toBe(false);
    expect(
      emailSendSchema.parse({
        ...base,
        conversationId: randomUUID(),
        replyToMessageId: "message",
      }).replyAll,
    ).toBe(false);
  });
  it("exposes explicit email actions in runtime API discovery and keeps credential setup board-only", () => {
    const operations = buildRunnerApiCatalog();
    const send = operations.find(o => o.path === "/api/companies/{companyId}/email/send");
    expect(send?.method).toBe("POST"); expect(send?.requestBody).toBeDefined();
    expect(send?.responses).toHaveProperty("202");
    const setup = operations.find(o => o.path === "/api/companies/{companyId}/email/inspect");
    expect(JSON.stringify(setup?.authorization)).toContain("board");
  });

});
