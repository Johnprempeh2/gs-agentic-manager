import { describe, expect, it } from "vitest";
import { mailboxConnectSchema } from "./mailbox.js";

const base = {
  label: "GS Mail",
  address: "john@example.co.uk",
  port: 993,
  secure: true,
  username: "john@example.co.uk",
  password: "x",
  idempotencyKey: "6f1c1b7e-4b1a-4c55-9a43-1b7f0e1d2a33",
};

describe("mailbox host", () => {
  it("keeps only the host when a URL is pasted", () => {
    expect(mailboxConnectSchema.parse({ ...base, host: " http://imap.hosts.co.uk/ " }).host).toBe("imap.hosts.co.uk");
    expect(mailboxConnectSchema.parse({ ...base, host: "imaps://imap.example.com/inbox" }).host).toBe("imap.example.com");
  });

  it("still refuses a host that is not a name, and says what to enter", () => {
    const result = mailboxConnectSchema.safeParse({ ...base, host: "imap example com" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Enter the server name only, such as imap.example.com");
  });
});
