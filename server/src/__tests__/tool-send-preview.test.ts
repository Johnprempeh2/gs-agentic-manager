import { describe, expect, it } from "vitest";
import { summarizeToolValue } from "../services/tool-content-guards.js";
import { buildHumanizedActionPreview } from "../services/tool-gateway.js";
import { isSendMessageTool } from "../services/tool-send-preview.js";

function preview(
  tool: { name: string; displayName?: string; risk?: "read" | "write" | "destructive" },
  parameters: Record<string, unknown>,
) {
  return buildHumanizedActionPreview({
    tool: {
      description: "",
      parametersSchema: {},
      pluginId: "test",
      providerType: "mcp_http",
      risk: "write",
      ...tool,
    } as Parameters<typeof buildHumanizedActionPreview>[0]["tool"],
    argumentsSummary: summarizeToolValue(parameters),
    parameters,
  });
}

const longBody = [
  "Hi Sam,",
  "",
  `Here is the full update. ${"All of this text must stay visible. ".repeat(150)}`,
  "",
  "Thanks,",
  "John",
].join("\n");

describe("approval preview for send/post tools (GRE-800)", () => {
  it("detects send, post, reply and forward tools by name", () => {
    expect(isSendMessageTool({ name: "gmail:send_email" })).toBe(true);
    expect(isSendMessageTool({ name: "slack_post_message" })).toBe(true);
    expect(isSendMessageTool({ name: "outlook:replyToMessage" })).toBe(true);
    expect(isSendMessageTool({ name: "x", displayName: "Forward email" })).toBe(true);
    expect(isSendMessageTool({ name: "mcp-remote-fixture:update_note" })).toBe(false);
    expect(isSendMessageTool({ name: "gmail:create_draft" })).toBe(false);
  });

  it("shows to, cc, bcc, subject and the full body of an email, uncut", () => {
    const markdown = preview(
      { name: "gmail:send_email", displayName: "Send email" },
      {
        to: ["sam@example.com", { name: "Ana Diaz", email: "ana@example.com" }],
        cc: "lee@example.com",
        bcc: [{ emailAddress: { address: "audit@example.com" } }],
        subject: "Quarterly update",
        body: longBody,
        threadId: "t-123",
      },
    );

    expect(markdown.split("\n").slice(0, 7)).toEqual([
      "Send email",
      "",
      "- **To:** sam\\@example.com, Ana Diaz \\<ana\\@example.com\\>",
      "- **Cc:** lee\\@example.com",
      "- **Bcc:** audit\\@example.com",
      "- **Subject:** Quarterly update",
      "- **Message:**",
    ]);
    // Every body line is quoted in full; blank lines stay inside the quote.
    expect(markdown).toContain("> Hi Sam,\n>\n> Here is the full update.");
    expect(markdown).toContain(`> ${longBody.split("\n")[2]}`);
    expect(markdown).toContain(">\n> Thanks,\n> John");
    expect(markdown).not.toContain("…");
    // Arguments that are not recipients, subject or body are still listed.
    expect(markdown).toContain("**Other details:**\n\n- **Thread ID:** t-123");
  });

  it("shows the channel and full text of a chat message", () => {
    const markdown = preview(
      { name: "slack_post_message", displayName: "Post message" },
      { channel: "#launch", text: longBody, idempotencyKey: "k-1" },
    );
    expect(markdown).toContain("- **Channel:** \\#launch");
    expect(markdown).toContain(`> ${longBody.split("\n")[2]}`);
    expect(markdown).toContain("- **Idempotency Key:** k-1");
  });

  it("shows message markdown as literal text so links and HTML cannot hide what is sent", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "[click here](https://evil.example) <b>now</b>" },
    );
    expect(markdown).toContain("> \\[click here\\](https\\://evil.example) \\<b\\>now\\</b\\>");
  });

  it("still redacts secrets in the body", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "Use Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456" },
    );
    expect(markdown).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("shows both the text and the HTML part of an email, each in full", () => {
    const html = `<p>Wire 50k to <a href='https://evil'>acct 999</a></p>`;
    const markdown = preview(
      { name: "gmail:send_email", displayName: "Send email" },
      { to: "sam@example.com", subject: "Hi", text: "Hello team", html },
    );
    expect(markdown).toContain("- **Message (Text):**\n\n> Hello team");
    // The HTML part is a fenced block the card draws as the recipient sees it (GRE-965).
    expect(markdown).toContain(`- **Message (HTML):**\n\n\`\`\`email-html\n${html}\n\`\`\``);
  });

  it("puts an HTML body in a fence no backticks inside it can close", () => {
    const html = "<p>Run <code>```rm```</code> and <code>````x````</code></p>";
    const markdown = preview({ name: "send_email" }, { to: "sam@example.com", html });
    expect(markdown).toContain(`\`\`\`\`\`email-html\n${html}\n\`\`\`\`\``);
  });

  it("treats a plain body as HTML only when the call says so", () => {
    const html = "<p>Hi <b>Sam</b></p>";
    for (const flags of [{ isHtml: true }, { contentType: "text/html" }, { mimeType: "text/html; charset=utf-8" }]) {
      const markdown = preview({ name: "send_email" }, { to: "sam@example.com", body: html, ...flags });
      expect(markdown).toContain(`\`\`\`email-html\n${html}\n\`\`\``);
    }
    // Without a flag, or with a plain-text type, the body stays escaped text.
    for (const flags of [{}, { contentType: "text/plain" }, { isHtml: false }]) {
      const markdown = preview({ name: "send_email" }, { to: "sam@example.com", body: html, ...flags });
      expect(markdown).not.toContain("email-html");
      expect(markdown).toContain("> \\<p\\>Hi \\<b\\>Sam\\</b\\>\\</p\\>");
    }
    // A flag never turns a `text` or `markdown` field into HTML.
    const both = preview(
      { name: "send_email" },
      { to: "sam@example.com", text: "<b>raw</b>", contentType: "html" },
    );
    expect(both).not.toContain("email-html");
  });

  it("still redacts secrets inside an HTML body", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", html: "<p>Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456</p>" },
    );
    expect(markdown).toContain("email-html");
    expect(markdown).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("shows a body object such as Outlook's { contentType, content } in full", () => {
    const markdown = preview(
      { name: "outlook:sendMail", displayName: "Send mail" },
      { toRecipients: "sam@example.com", body: { contentType: "HTML", content: longBody } },
    );
    expect(markdown).toContain("- **Message (Body Content, Content Type\\: HTML):**");
    expect(markdown).toContain(`\`\`\`email-html\n${longBody}\n\`\`\``);
  });

  it("keeps a text body object as quoted text", () => {
    const markdown = preview(
      { name: "outlook:sendMail", displayName: "Send mail" },
      { toRecipients: "sam@example.com", body: { contentType: "Text", content: "<b>Hi</b>" } },
    );
    expect(markdown).not.toContain("email-html");
    expect(markdown).toContain("> \\<b\\>Hi\\</b\\>");
  });

  it("never says the message is empty when it has content, and lists attachments", () => {
    const markdown = preview(
      { name: "gmail:send_email", displayName: "Send email" },
      {
        to: "sam@example.com",
        subject: "Plan",
        markdown: "Secret plan attached",
        attachments: [{ filename: "payroll.xlsx" }],
        notes: `First line\n${"x".repeat(200)}`,
      },
    );
    expect(markdown).not.toContain("empty");
    expect(markdown).toContain("- **Message:**\n\n> Secret plan attached");
    expect(markdown).toContain('- **Attachments:** \\[{"filename"\\:"payroll.xlsx"}\\]');
    // Long or multi-line extra text is quoted in full, not cut.
    expect(markdown).toContain(`- **Notes:**\n\n  > First line\n  > ${"x".repeat(200)}`);
  });

  it("lists unknown fields when the message has no text field at all", () => {
    const markdown = preview(
      { name: "slack_post_message", displayName: "Post message" },
      { channel: "#launch", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Launch!" } }] },
    );
    expect(markdown).not.toContain("no text");
    expect(markdown).toContain("- **Blocks:**");
    expect(markdown).toContain("Launch!");
  });

  it("shows Slack blocks in full, because the recipient sees the blocks, not the text", () => {
    const tail = "End of the blocks, wire 50k to acct 999";
    const blocks = [
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "section",
        text: { type: "mrkdwn", text: `Section ${index} ${"filler ".repeat(20)}` },
      })),
      { type: "section", text: { type: "mrkdwn", text: tail } },
    ];
    const markdown = preview(
      { name: "slack_post_message", displayName: "Post message" },
      { channel: "#launch", text: "ok", blocks },
    );
    expect(markdown).toContain("- **Message:**\n\n> ok");
    expect(markdown).toContain("- **Blocks:**\n\n  > \\[");
    expect(markdown).toContain(tail);
    expect(markdown).not.toContain("…");
  });

  it("shows an MCP-style content list in full", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", content: [{ type: "text", text: longBody }] },
    );
    expect(markdown).toContain("- **Content:**");
    expect(markdown).toContain("All of this text must stay visible. ".repeat(150).trim());
    expect(markdown).toContain("Thanks,\\\\nJohn");
    expect(markdown).not.toContain("…");
  });

  it("shortens only large file data inside an argument, and says how much was left out", () => {
    const data = "QUJD".repeat(500);
    const markdown = preview(
      { name: "gmail:send_email", displayName: "Send email" },
      {
        to: "sam@example.com",
        body: "See file",
        attachments: [
          { filename: "payroll.xlsx", data },
          { filename: "logo.png", url: `data:image/png;base64,${data}` },
        ],
      },
    );
    expect(markdown).toContain("payroll.xlsx");
    expect(markdown).toContain("\\[file data, 2,000 characters not shown\\]");
    expect(markdown).toContain("\\[file data, 2,022 characters not shown\\]");
    expect(markdown).not.toContain(data);
  });

  it("never hides long text that is not in a file-data field", () => {
    // A long word with no spaces is valid base64, but it is readable.
    const word = "WIRE50KTOACCT999".repeat(80);
    const words = "wire the money now ".repeat(80).trim();
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "Hi", note: words, ref: word, raw: word },
    );
    expect(markdown).toContain(words);
    expect(markdown.split(word)).toHaveLength(3);
    expect(markdown).not.toContain("file data");
  });

  it("shows a recipient item it cannot read as an address raw, instead of dropping it", () => {
    const markdown = preview(
      { name: "send_email" },
      {
        to: ["a@x.com", { foo: "evil@x.com" }, { name: "Bo", email: "bo@x.com", extra: "c@x.com" }],
        body: "Hi",
      },
    );
    expect(markdown).toContain(
      '- **To:** a\\@x.com, {"foo"\\:"evil\\@x.com"}, {"name"\\:"Bo","email"\\:"bo\\@x.com","extra"\\:"c\\@x.com"}',
    );
  });

  it("escapes argument names, so a key cannot add a link to the card", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "Hi", "[ok](https://evil.example)": "x" },
    );
    expect(markdown).toContain("- **\\[ok\\](https\\://evil Example):** x");
  });

  it("says there is no text only when nothing else is sent", () => {
    const markdown = preview({ name: "send_email" }, { to: "sam@example.com", body: "" });
    expect(markdown).toBe("send_email\n\n- **To:** sam\\@example.com\n- **Message:** no text");
  });

  it("keeps the short preview for a send tool without message fields", () => {
    expect(preview({ name: "send_invite", displayName: "Send invite" }, { role: "viewer" })).toBe(
      "Send invite · **Role:** viewer",
    );
  });

  it("keeps the short, cut preview for other tools", () => {
    const markdown = preview(
      { name: "mcp-remote-fixture:update_note", displayName: "Update note" },
      { noteId: "n1", body: `Hi Sam, ${"more note text ".repeat(20)}` },
    );
    expect(markdown.startsWith("Update note · **Body:** Hi Sam,")).toBe(true);
    expect(markdown).toContain("…");
    expect(markdown).not.toContain("\n\n");
  });
});
