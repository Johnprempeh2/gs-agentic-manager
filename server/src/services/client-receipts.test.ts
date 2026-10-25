import { describe, expect, it } from "vitest";
import type { Db } from "@greatstone/db";
import { clientReceiptSender, receiptEmail, type ClientReceipt } from "./client-receipts.js";

const receipt: ClientReceipt = {
  to: "ada@example.com",
  recipientName: "Ada <Mensah>",
  companyName: "Greatstone",
  clientName: "Northwind Logistics",
  deliverableTitle: "North Star summary",
  version: 2,
  fingerprint: "a".repeat(64),
  acceptedAt: new Date("2026-10-25T09:00:00.000Z"),
  idempotencyKey: "client-receipt-1",
};

const SECRET = JSON.stringify({ apiKey: "re_sending_only_test", from: "Greatstone <receipts@example.com>" });

function fakeFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: response.ok, status: response.status, json: async () => response.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("client receipt email", () => {
  it("names the deliverable, version, client and reference, and escapes HTML", () => {
    const email = receiptEmail(receipt);
    expect(email.subject).toBe("Receipt: you accepted North Star summary");
    expect(email.text).toContain('"North Star summary" (version 2) from Greatstone for Northwind Logistics');
    expect(email.text).toContain(`Reference: ${"a".repeat(64)}`);
    expect(email.html).toContain("Ada &lt;Mensah&gt;");
    expect(email.html).not.toContain("<Mensah>");
  });
});

describe("client receipt sender", () => {
  it("sends through Resend with the sending-only key and an idempotency key", async () => {
    const fetch = fakeFetch({ ok: true, status: 200, body: { id: "msg-1" } });
    const sender = clientReceiptSender({} as Db, { fetchImpl: fetch.impl, readSecret: async () => SECRET });
    await expect(sender.send("company-1", receipt)).resolves.toEqual({ status: "sent", messageId: "msg-1" });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = fetch.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_sending_only_test");
    expect(headers["Idempotency-Key"]).toBe("client-receipt-1");
    expect(JSON.parse(String(fetch.calls[0]!.init.body))).toMatchObject({
      from: "Greatstone <receipts@example.com>",
      to: ["ada@example.com"],
      subject: "Receipt: you accepted North Star summary",
    });
  });

  it("reports a missing or unreadable key as not configured, without calling Resend", async () => {
    const fetch = fakeFetch({ ok: true, status: 200, body: {} });
    for (const secret of [null, "not json", JSON.stringify({ apiKey: "re_x" })]) {
      const sender = clientReceiptSender({} as Db, { fetchImpl: fetch.impl, readSecret: async () => secret });
      const outcome = await sender.send("company-1", receipt);
      expect(outcome.status).toBe("not_configured");
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("reports Resend's refusal without echoing the key", async () => {
    const fetch = fakeFetch({ ok: false, status: 403, body: { message: "The example.com domain is not verified" } });
    const sender = clientReceiptSender({} as Db, { fetchImpl: fetch.impl, readSecret: async () => SECRET });
    const outcome = await sender.send("company-1", receipt);
    expect(outcome).toEqual({ status: "failed", error: "Resend refused the receipt: The example.com domain is not verified" });
    expect(JSON.stringify(outcome)).not.toContain("re_sending_only_test");
  });
});
