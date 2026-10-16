import express from "express";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Board chat messages can carry files (uploads throughout the journey,
// 16 Oct): they must be attachments on the board conversation, and the
// assistant gets a copy in its run folder to read.

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  getAttachmentById: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());
const mockResolveCredential = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));
vi.mock("../services/board-chat-claude-credential.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/board-chat-claude-credential.js")>()),
  resolveBoardChatClaudeCredential: mockResolveCredential,
}));
vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", actorType: "user", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

/** A CLI that records its prompt and what the listed files held, then answers. */
function fakeProc(seen: { prompt: string; files: Record<string, string> }) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn();
  proc.stdin = {
    write: vi.fn((text: string) => {
      seen.prompt += text;
    }),
    end: vi.fn(() => {
      for (const match of seen.prompt.matchAll(/^- (\/.+?) \(/gm)) {
        seen.files[match[1]!] = fs.readFileSync(match[1]!, "utf8");
      }
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", result: "Read it." })}\n`));
        proc.exitCode = 0;
        proc.emit("close", 0);
      });
    }),
  };
  return proc;
}

const storage = {
  provider: "local_disk",
  getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from("quarterly numbers")]), contentType: "text/csv" })),
};

async function app() {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const server = express();
  server.use(express.json());
  server.use("/api", boardChatRoutes({} as any, { deploymentMode: "local_trusted", storage: storage as any }));
  return server;
}

const attachment = {
  id: "att-1",
  companyId: "company-1",
  issueId: "issue-1",
  objectKey: "k/1",
  contentType: "text/csv",
  byteSize: 17,
  originalFilename: "../Q3 numbers.csv",
};

describe("board chat attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([{ id: "issue-1", title: "Board Operations", status: "todo" }]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockResolveCredential.mockResolvedValue({ envKey: "CLAUDE_CODE_OAUTH_TOKEN", value: "token" });
  });

  it("finds the board conversation so files can be attached before the first message", async () => {
    const res = await request(await app()).post("/api/board/chat/issue").send({ companyId: "company-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issueId: "issue-1" });
  });

  it("links the files in the saved message and hands the assistant a copy to read", async () => {
    mockIssueService.getAttachmentById.mockResolvedValue(attachment);
    const seen = { prompt: "", files: {} as Record<string, string> };
    mockSpawn.mockReturnValue(fakeProc(seen));

    const res = await request(await app())
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "What do these show?", attachmentIds: ["att-1"] });

    expect(res.text).toContain('"type":"done"');
    const [, body] = mockIssueService.addComment.mock.calls[0]!;
    expect(body).toBe("What do these show?\n\n[../Q3 numbers.csv](/api/attachments/att-1/content)");
    expect(seen.prompt).toContain("Read them with your Read tool");
    const paths = Object.keys(seen.files);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\/attachments\/1-Q3 numbers\.csv$/);
    expect(seen.files[paths[0]!]).toBe("quarterly numbers");
    // The run folder, and the copy with it, is removed when the run ends.
    await vi.waitFor(() => expect(fs.existsSync(paths[0]!)).toBe(false));
  });

  it("refuses a file from another conversation or company, and too many files", async () => {
    mockIssueService.getAttachmentById.mockResolvedValue({ ...attachment, issueId: "issue-other" });
    const server = await app();
    const other = await request(server)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "Look", attachmentIds: ["att-1"] });
    expect(other.status).toBe(422);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    const many = await request(server)
      .post("/api/board/chat/stream")
      .send({ companyId: "company-1", message: "Look", attachmentIds: ["a", "b", "c", "d", "e", "f"] });
    expect(many.status).toBe(422);
  });
});
