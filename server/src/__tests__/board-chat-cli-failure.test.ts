import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GRE-234: a failed `claude` CLI run must surface as an SSE error, never as a
// streamed chunk or a saved board-concierge reply.

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

type FakeRun = { stdoutLines: object[]; stderr?: string; exitCode: number };

function makeFakeProc(run: FakeRun) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  proc.stdin = {
    write: vi.fn(),
    // Play the scripted run once the relay has sent the prompt.
    end: vi.fn(() => {
      setImmediate(() => {
        for (const line of run.stdoutLines) {
          proc.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
        }
        if (run.stderr) proc.stderr.emit("data", Buffer.from(run.stderr));
        proc.exitCode = run.exitCode;
        proc.emit("close", run.exitCode);
      });
    }),
  };
  return proc;
}

function parseSse(text: string): any[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)));
}

async function runChat(run: FakeRun) {
  mockSpawn.mockReturnValue(makeFakeProc(run));
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use("/api", boardChatRoutes({} as any, { deploymentMode: "local_trusted" }));
  const res = await request(app)
    .post("/api/board/chat/stream")
    .send({ companyId: "company-1", message: "hello" });
  return parseSse(res.text);
}

function conciergeComments() {
  return mockIssueService.addComment.mock.calls.filter(
    ([, , author]) => author?.userId === "board-concierge",
  );
}

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

describe("board-chat relay CLI failure handling (GRE-234)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([
      { id: "issue-1", title: "Board Operations", status: "todo" },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.listComments.mockResolvedValue([]);
  });

  it("sends an SSE error, not a chunk, for a result event with is_error: true", async () => {
    const events = await runChat({
      stdoutLines: [
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        },
      ],
      exitCode: 0,
    });

    expect(events.filter((e) => e.type === "chunk")).toEqual([]);
    const error = events.find((e) => e.type === "error");
    expect(error?.message).toContain("Not logged in · Please run /login");
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(conciergeComments()).toEqual([]);
  });

  it("sends an SSE error and saves nothing on a non-zero exit, even after streamed text", async () => {
    const events = await runChat({
      stdoutLines: [delta("Partial answer")],
      stderr: "fatal: something broke",
      exitCode: 1,
    });

    const error = events.find((e) => e.type === "error");
    expect(error?.message).toContain("fatal: something broke");
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(conciergeComments()).toEqual([]);
  });

  it("streams and saves the reply for a normal run", async () => {
    const events = await runChat({
      stdoutLines: [
        delta("Hello "),
        delta("board."),
        { type: "result", subtype: "success", is_error: false, result: "Hello board." },
      ],
      exitCode: 0,
    });

    expect(events.filter((e) => e.type === "chunk").map((e) => e.text)).toEqual([
      "Hello ",
      "board.",
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", issueId: "issue-1", exitCode: 0 });
    expect(conciergeComments()).toEqual([
      ["issue-1", "Hello board.", { userId: "board-concierge" }],
    ]);
  });
});
