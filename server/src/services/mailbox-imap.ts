import { ImapFlow, type FetchMessageObject } from "imapflow";
import type {
  MailboxAddress,
  MailboxMessageSummary,
  MailboxSearchInput,
} from "@greatstone/shared";
import { HttpError } from "../errors.js";

// The one IMAP seam. Everything above it is provider-neutral, so tests swap in
// a fake and an XOAUTH2 client (Microsoft 365, Gmail) can slot in later.

export const MAX_MAILBOX_MESSAGE_BYTES = 25 * 1024 * 1024;

export type MailboxAccount = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export interface MailboxClient {
  /** Sign in and list folder paths. Throws MailboxAuthError on bad credentials. */
  folders(): Promise<string[]>;
  search(query: MailboxSearchInput): Promise<MailboxMessageSummary[]>;
  /** Raw RFC 822 source, or null when the message no longer exists. */
  source(folder: string, uid: number): Promise<Buffer | null>;
}

export type MailboxClientFactory = (account: MailboxAccount) => MailboxClient;

/**
 * Sign-in failures never repeat the server's text: some servers echo the
 * username or a hint, and this message reaches agents and logs.
 */
export class MailboxAuthError extends HttpError {
  constructor() {
    super(
      422,
      "Mailbox sign-in failed. Check the username and app password, then reconnect the mailbox.",
      { code: "mailbox_auth_failed" },
    );
  }
}

export class MailboxUnavailableError extends HttpError {
  constructor(reason: string) {
    super(502, `Mailbox server is unavailable: ${reason}`, {
      code: "mailbox_unavailable",
    });
  }
}

function addresses(
  list: Array<{ name?: string; address?: string }> | undefined,
): MailboxAddress[] {
  return (list ?? []).map((entry) => ({
    name: entry.name || null,
    address: entry.address || null,
  }));
}

function summary(folder: string, message: FetchMessageObject): MailboxMessageSummary {
  const envelope = message.envelope;
  const date = envelope?.date ?? message.internalDate;
  return {
    uid: message.uid,
    folder,
    messageId: envelope?.messageId ?? null,
    subject: envelope?.subject ?? null,
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    date: date ? new Date(date).toISOString() : null,
    size: message.size ?? null,
  };
}

function mapError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const err = error as { authenticationFailed?: boolean; code?: string };
  if (err?.authenticationFailed) throw new MailboxAuthError();
  const code = typeof err?.code === "string" ? err.code : "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code))
    throw new MailboxUnavailableError("host not found");
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"].includes(code))
    throw new MailboxUnavailableError("connection refused");
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT" || code === "GREETING_TIMEOUT")
    throw new MailboxUnavailableError("connection timed out");
  if (/CERT|TLS|SSL/i.test(code))
    throw new MailboxUnavailableError("secure connection failed");
  throw new MailboxUnavailableError("the server rejected the request");
}

function imapDate(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

export const imapMailboxClient: MailboxClientFactory = (account) => {
  async function session<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.username, pass: account.password },
      // imapflow logs to stdout by default. Never let protocol traffic
      // (which includes the LOGIN command) reach a log sink.
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      maxLiteralSize: MAX_MAILBOX_MESSAGE_BYTES,
    });
    // An error after connect would otherwise crash the process.
    client.on("error", () => {});
    try {
      await client.connect();
    } catch (error) {
      mapError(error);
    }
    try {
      return await work(client);
    } catch (error) {
      mapError(error);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  return {
    folders: () =>
      session(async (client) =>
        (await client.list()).map((entry) => entry.path),
      ),
    search: (query) =>
      session(async (client) => {
        // EXAMINE: reading never changes \Seen or any other flag.
        const lock = await client.getMailboxLock(query.folder, { readOnly: true });
        try {
          const criteria = {
            ...(query.from ? { from: query.from } : {}),
            ...(query.to ? { to: query.to } : {}),
            ...(query.subject ? { subject: query.subject } : {}),
            ...(query.text ? { text: query.text } : {}),
            ...(query.since ? { since: imapDate(query.since) } : {}),
            ...(query.before ? { before: imapDate(query.before) } : {}),
          };
          const uids =
            (await client.search(
              Object.keys(criteria).length ? criteria : { all: true },
              { uid: true },
            )) || [];
          const newest = [...uids].sort((a, b) => b - a).slice(0, query.limit);
          if (!newest.length) return [];
          const rows = await client.fetchAll(
            newest.join(","),
            { uid: true, envelope: true, size: true, internalDate: true },
            { uid: true },
          );
          return rows
            .map((row) => summary(query.folder, row))
            .sort((a, b) => b.uid - a.uid);
        } finally {
          lock.release();
        }
      }),
    source: (folder, uid) =>
      session(async (client) => {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const head = await client.fetchOne(
            String(uid),
            { uid: true, size: true },
            { uid: true },
          );
          if (!head) return null;
          if ((head.size ?? 0) > MAX_MAILBOX_MESSAGE_BYTES)
            throw new HttpError(422, "This message is larger than 25 MB", {
              code: "mailbox_message_too_large",
            });
          const message = await client.fetchOne(
            String(uid),
            { uid: true, source: true },
            { uid: true },
          );
          return message && message.source ? message.source : null;
        } finally {
          lock.release();
        }
      }),
  };
};
