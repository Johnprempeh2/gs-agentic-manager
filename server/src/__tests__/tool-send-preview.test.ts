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
      "- **To:** sam@example.com, Ana Diaz \\<ana@example.com\\>",
      "- **Cc:** lee@example.com",
      "- **Bcc:** audit@example.com",
      "- **Subject:** Quarterly update",
      "- **Message:**",
    ]);
    // Every body line is quoted in full; blank lines stay inside the quote.
    expect(markdown).toContain("> Hi Sam,\n>\n> Here is the full update.");
    expect(markdown).toContain(`> ${longBody.split("\n")[2]}`);
    expect(markdown).toContain(">\n> Thanks,\n> John");
    expect(markdown).not.toContain("…");
    expect(markdown).not.toContain("t-123");
  });

  it("shows the channel and full text of a chat message", () => {
    const markdown = preview(
      { name: "slack_post_message", displayName: "Post message" },
      { channel: "#launch", text: longBody, idempotencyKey: "k-1" },
    );
    expect(markdown).toContain("- **Channel:** \\#launch");
    expect(markdown).toContain(`> ${longBody.split("\n")[2]}`);
    expect(markdown).not.toContain("k-1");
  });

  it("shows message markdown as literal text so links and HTML cannot hide what is sent", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "[click here](https://evil.example) <b>now</b>" },
    );
    expect(markdown).toContain("> \\[click here\\](https://evil.example) \\<b\\>now\\</b\\>");
  });

  it("still redacts secrets in the body", () => {
    const markdown = preview(
      { name: "send_email" },
      { to: "sam@example.com", body: "Use Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456" },
    );
    expect(markdown).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz123456");
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
