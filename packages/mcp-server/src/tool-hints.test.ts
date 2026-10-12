import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hasMcpToolHints } from "@greatstone/shared";
import { describe, expect, it } from "vitest";
import { createPaperclipMcpServer } from "./index.js";

const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

// Pinned so a changed effect is a deliberate, reviewed edit. Every other tool is a read.
const DESTRUCTIVE = ["paperclipApiRequest", "paperclipUnlinkIssueApproval"];
const WRITES = [
  "connection_request",
  "paperclipControlIssueWorkspaceServices",
  "paperclipCreateApproval",
  "paperclipCreateIssue",
  "paperclipUpdateIssue",
  "paperclipCheckoutIssue",
  "paperclipReleaseIssue",
  "paperclipAddComment",
  "paperclipSuggestTasks",
  "paperclipAskUserQuestions",
  "paperclipRequestConfirmation",
  "paperclipRequestCheckboxConfirmation",
  "paperclipUpsertIssueDocument",
  "paperclipRestoreIssueDocumentRevision",
  "paperclipLinkIssueApproval",
  "paperclipApprovalDecision",
  "paperclipAddApprovalComment",
];

async function listTools() {
  const { server } = createPaperclipMcpServer(config);
  const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("paperclip MCP tool hints", () => {
  it("advertises effect hints for every tool over tools/list", async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((tool) => !hasMcpToolHints(tool.annotations)).map((tool) => tool.name)).toEqual([]);
  });

  it("declares the reviewed effect for each tool", async () => {
    const tools = await listTools();
    const effect = (annotations: typeof tools[number]["annotations"]) =>
      annotations?.readOnlyHint ? "read" : annotations?.destructiveHint ? "destructive" : "write";
    const byEffect = (wanted: string) =>
      tools.filter((tool) => effect(tool.annotations) === wanted).map((tool) => tool.name).sort();
    expect(byEffect("destructive")).toEqual([...DESTRUCTIVE].sort());
    expect(byEffect("write")).toEqual([...WRITES].sort());
    expect(tools.find((tool) => tool.name === "paperclipGetIssue")?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });
});
