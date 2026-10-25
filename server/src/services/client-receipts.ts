import type { Db } from "@greatstone/db";
import { secretService } from "./secrets.js";

// The receipt a client gets when they accept a published deliverable
// (GRE-2373). Resend is agent-run (John, 20 Oct): an agent makes a
// sending-only key for the sending domain and saves it as the company secret
// below. The account's Full access key is never used here. The secret holds
// JSON: { "apiKey": "re_...", "from": "Greatstone <receipts@example.com>" }.

export const CLIENT_RECEIPT_SECRET_KEY = "client-receipts-resend";
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export type ClientReceipt = {
  to: string;
  recipientName: string;
  companyName: string;
  clientName: string;
  deliverableTitle: string;
  version: number | null;
  fingerprint: string;
  acceptedAt: Date;
  /** Makes a retry send the same email once. */
  idempotencyKey: string;
};

export type ClientReceiptOutcome =
  | { status: "sent"; messageId: string | null }
  | { status: "not_configured"; error: string }
  | { status: "failed"; error: string };

export type ClientReceiptSender = {
  configured: (companyId: string) => Promise<boolean>;
  send: (companyId: string, receipt: ClientReceipt) => Promise<ClientReceiptOutcome>;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!
  ));
}

export function receiptEmail(receipt: ClientReceipt) {
  const version = receipt.version ? ` (version ${receipt.version})` : "";
  const when = receipt.acceptedAt.toUTCString();
  const subject = `Receipt: you accepted ${receipt.deliverableTitle}`;
  const lines = [
    `Dear ${receipt.recipientName},`,
    `This confirms that you accepted "${receipt.deliverableTitle}"${version} from ${receipt.companyName} for ${receipt.clientName} on ${when}.`,
    `Reference: ${receipt.fingerprint}`,
    "Keep this email as your record. If you did not accept this deliverable, reply to tell us.",
  ];
  return {
    subject,
    text: lines.join("\n\n"),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
  };
}

function readSenderConfig(raw: string): { apiKey: string; from: string } | null {
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown; from?: unknown };
    if (typeof parsed.apiKey === "string" && parsed.apiKey.trim() && typeof parsed.from === "string" && parsed.from.trim()) {
      return { apiKey: parsed.apiKey.trim(), from: parsed.from.trim() };
    }
  } catch {
    // Not JSON: reported as not configured below.
  }
  return null;
}

export function clientReceiptSender(
  db: Db,
  deps: { fetchImpl?: typeof fetch; readSecret?: (companyId: string) => Promise<string | null> } = {},
): ClientReceiptSender {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secrets = secretService(db);
  const readSecret = deps.readSecret ?? readCompanySecret;

  async function readCompanySecret(companyId: string) {
    const secret = await secrets.getByKey(companyId, CLIENT_RECEIPT_SECRET_KEY);
    if (!secret || secret.status !== "active") return null;
    return secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: CLIENT_RECEIPT_SECRET_KEY,
        configPath: "client-receipts",
        actorType: "system",
        actorId: null,
      },
    });
  }

  async function loadConfig(companyId: string) {
    const raw = await readSecret(companyId);
    return raw ? readSenderConfig(raw) : null;
  }

  return {
    configured: async (companyId) => {
      if (deps.readSecret) return Boolean(await deps.readSecret(companyId));
      const secret = await secrets.getByKey(companyId, CLIENT_RECEIPT_SECRET_KEY);
      return Boolean(secret && secret.status === "active");
    },

    send: async (companyId, receipt) => {
      let config: { apiKey: string; from: string } | null;
      try {
        config = await loadConfig(companyId);
      } catch {
        config = null;
      }
      if (!config) {
        return {
          status: "not_configured",
          error: `No sending key: save a Resend sending-only key as the company secret "${CLIENT_RECEIPT_SECRET_KEY}", then send the receipt again.`,
        };
      }
      const email = receiptEmail(receipt);
      try {
        const response = await fetchImpl(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": receipt.idempotencyKey,
          },
          body: JSON.stringify({ from: config.from, to: [receipt.to], subject: email.subject, text: email.text, html: email.html }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          // Resend's error names the problem (domain not verified, key revoked); never echo the key.
          const body = await response.json().catch(() => null) as { message?: unknown } | null;
          const message = typeof body?.message === "string" ? body.message.slice(0, 300) : `HTTP ${response.status}`;
          return { status: "failed", error: `Resend refused the receipt: ${message}` };
        }
        const body = await response.json().catch(() => null) as { id?: unknown } | null;
        return { status: "sent", messageId: typeof body?.id === "string" ? body.id : null };
      } catch (error) {
        return { status: "failed", error: `Could not reach Resend: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
      }
    },
  };
}
