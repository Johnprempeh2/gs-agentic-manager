import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  imapMailboxClient,
  MailboxAuthError,
  MailboxUnavailableError,
} from "../services/mailbox-imap.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { redactSensitive } from "../middleware/redact-sensitive.js";

const PASSWORD = "imap-secret-4b1d";

/**
 * A minimal IMAP server: enough of RFC 3501 for LOGIN, LIST, EXAMINE,
 * UID SEARCH and UID FETCH. It records every command it receives.
 */
function startServer() {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    socket.write("* OK [CAPABILITY IMAP4rev1] test server ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const [tag, rawCommand, ...rest] = line.split(" ");
        const command = (rawCommand ?? "").toUpperCase();
        const sub = (rest[0] ?? "").toUpperCase();
        const reply = (...lines: string[]) => socket.write(lines.map((l) => `${l}\r\n`).join(""));
        if (command === "LOGIN") {
          if (new RegExp(`[\\s"]${PASSWORD}"?$`).test(line)) reply(`${tag} OK [CAPABILITY IMAP4rev1] logged in`);
          // Some servers echo the attempted credentials back.
          else reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials ${rest.join(" ")}`);
        } else if (command === "CAPABILITY") {
          reply("* CAPABILITY IMAP4rev1", `${tag} OK done`);
        } else if (command === "LIST" && line.endsWith('"" ""')) {
          reply('* LIST (\\Noselect) "/" ""', `${tag} OK done`);
        } else if (command === "LIST") {
          reply('* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\HasNoChildren) "/" "Archive"', `${tag} OK done`);
        } else if (command === "EXAMINE" || command === "SELECT") {
          reply(
            "* 2 EXISTS",
            "* 0 RECENT",
            "* OK [UIDVALIDITY 1] ok",
            "* OK [UIDNEXT 8] ok",
            "* FLAGS (\\Seen)",
            `${tag} OK [READ-ONLY] done`,
          );
        } else if (command === "UID" && sub === "SEARCH") {
          reply("* SEARCH 3 7", `${tag} OK done`);
        } else if (command === "UID" && sub === "FETCH") {
          reply(
            '* 2 FETCH (UID 7 RFC822.SIZE 120 INTERNALDATE "07-Oct-2026 10:00:00 +0000" ENVELOPE ("Tue, 07 Oct 2026 10:00:00 +0000" "Q3 contract draft" (("Ama Mensah" NIL "ama" "client.example")) NIL NIL (("John" NIL "john" "greatstone.example")) NIL NIL NIL "<q3@client.example>"))',
            '* 1 FETCH (UID 3 RFC822.SIZE 80 INTERNALDATE "01-Sep-2026 10:00:00 +0000" ENVELOPE ("Mon, 01 Sep 2026 10:00:00 +0000" "Lunch" (("Kofi" NIL "kofi" "other.example")) NIL NIL NIL NIL NIL NIL "<lunch@other.example>"))',
            `${tag} OK done`,
          );
        } else if (command === "LOGOUT") {
          reply("* BYE bye", `${tag} OK done`);
          socket.end();
        } else {
          reply(`${tag} OK done`);
        }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise<{ port: number; commands: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, commands, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

describe("IMAP mailbox client", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const written: string[] = [];
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    server.commands.length = 0;
  });
  function captureOutput() {
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof stream.write);
  }
  const account = (password = PASSWORD) => ({
    host: "127.0.0.1",
    port: server.port,
    secure: false,
    username: "john@greatstone.example",
    password,
  });

  it("searches read-only (EXAMINE) with the requested criteria, newest first", async () => {
    const results = await imapMailboxClient(account()).search({
      folder: "INBOX",
      from: "ama@client.example",
      subject: "Q3",
      since: "2026-09-01",
      before: "2026-10-31",
      limit: 25,
    });
    expect(results.map((r) => r.uid)).toEqual([7, 3]);
    expect(results[0]).toMatchObject({
      subject: "Q3 contract draft",
      from: [{ name: "Ama Mensah", address: "ama@client.example" }],
      to: [{ name: "John", address: "john@greatstone.example" }],
      messageId: "<q3@client.example>",
      size: 120,
    });
    expect(server.commands.some((c) => /^\S+ EXAMINE /i.test(c))).toBe(true);
    expect(server.commands.some((c) => /^\S+ SELECT /i.test(c))).toBe(false);
    const search = server.commands.find((c) => / UID SEARCH /i.test(c))!;
    expect(search).toMatch(/FROM "?ama@client\.example"?/i);
    expect(search).toMatch(/SUBJECT "?Q3"?/i);
    expect(search).toMatch(/SINCE 0?1-Sep-2026/i);
    expect(search).toMatch(/BEFORE 31-Oct-2026/i);
    // Nothing in the session writes flags, moves or deletes.
    expect(server.commands.some((c) => /STORE|EXPUNGE|MOVE|COPY|APPEND|DELETE/i.test(c))).toBe(false);
  });

  it("lists folders after signing in", async () => {
    expect(await imapMailboxClient(account()).folders()).toEqual(["INBOX", "Archive"]);
  });

  it("maps a rejected sign-in to MailboxAuthError without repeating the server's text", async () => {
    captureOutput();
    const error = await imapMailboxClient(account("wrong-" + PASSWORD))
      .folders()
      .catch((e: unknown) => e);
    vi.restoreAllMocks();
    expect(error).toBeInstanceOf(MailboxAuthError);
    expect((error as Error).message).toMatch(/sign-in failed/i);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect((error as Error).message).not.toContain(PASSWORD);
    // imapflow's default logger is off: no protocol line (including LOGIN) reaches output.
    expect(written.join("")).not.toContain(PASSWORD);
  });

  it("reports an unreachable server as unavailable", async () => {
    const error = await imapMailboxClient({ ...account(), port: 1 }).folders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxUnavailableError);
  });

  it("keeps the add-mailbox request out of HTTP failure logs", () => {
    expect(isSecretSensitiveHttpRequest("POST", "/api/companies/c1/mailboxes")).toBe(true);
    expect(redactSensitive({ host: "imap.example.com", password: PASSWORD })).toEqual({
      host: "imap.example.com",
      password: "[REDACTED]",
    });
  });
});
