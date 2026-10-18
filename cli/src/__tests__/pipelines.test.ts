import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeDealNextStep, registerPipelineCommands, selectDealsDue } from "../commands/pipelines.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "11111111-1111-4111-8111-111111111111";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerPipelineCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base",
    "http://localhost:3100",
    "--api-key",
    "board-token",
    "--company-id",
    COMPANY_ID,
  ], { from: "user" });
}

describe("pipeline CLI commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GSAM_API_KEY;
    delete process.env.GSAM_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends request-changes review decisions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ case: { id: CASE_ID } }));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "pipelines",
      "case",
      "review",
      CASE_ID,
      "--request-changes",
      "--reason",
      "Needs edits",
      "--expected-version",
      "2",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/cases/${CASE_ID}/review`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      decision: "request_changes",
      reason: "Needs edits",
      expectedVersion: 2,
    });
  });

  it("passes request_changes rows through review-bulk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-pipeline-cli-"));
    const file = join(dir, "review-bulk.json");
    await writeFile(file, JSON.stringify([
      { caseId: CASE_ID, decision: "request_changes", reason: "Needs edits", expectedVersion: 2 },
    ]));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run(["pipelines", "review-bulk", "--file", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/review-cases/bulk`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      items: [{ caseId: CASE_ID, decision: "request_changes", reason: "Needs edits", expectedVersion: 2 }],
    });
  });

  it("passes blockedByCaseKeys rows through ingest-batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-pipeline-cli-"));
    const file = join(dir, "ingest-batch.json");
    await writeFile(file, JSON.stringify([
      { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
      { caseKey: "image", title: "Image" },
      { caseKey: "post", title: "Post" },
    ]));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "33333333-3333-4333-8333-333333333333", key: "content", name: "Content" }]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run(["pipelines", "ingest-batch", "content", "--file", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/pipelines/33333333-3333-4333-8333-333333333333/cases/batch");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      items: [
        { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
        { caseKey: "image", title: "Image" },
        { caseKey: "post", title: "Post" },
      ],
    });
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("selectDealsDue", () => {
  const stage = (kind: string) => ({ id: kind, key: kind, name: kind === "done" ? "Won" : "Qualified", kind, position: 0 });
  const row = (title: string, fields: Record<string, unknown> | null, kind = "working") => ({
    case: { id: title, caseKey: title, title, pipelineId: "p", stageId: kind, version: 1, fields },
    stage: stage(kind),
  });

  it("lists open deals due by the given day, oldest first, and unscheduled ones on request", () => {
    const pipelines = [{
      id: "p",
      name: "DevTools",
      rows: [
        row("Acme", { dealStatus: "Open", nextActivityDate: "2026-10-17", nextActivitySubject: "Demo" }),
        row("Globex", { dealStatus: "Open", nextActivityDate: "2026-10-12" }),
        row("Initech", { dealStatus: "Open", nextActivityDate: "2026-10-30" }),
        row("Hooli", { dealStatus: "Open" }),
        row("Umbrella", { dealStatus: "Lost", nextActivityDate: "2026-10-01" }),
        row("Won deal", { dealStatus: "Open", nextActivityDate: "2026-10-01" }, "done"),
        row("Client card", { nextActivityDate: "2026-10-01" }),
      ],
    }];
    expect(selectDealsDue(pipelines, "2026-10-17").map((deal) => [deal.title, deal.nextActivityDate, deal.nextActivitySubject])).toEqual([
      ["Globex", "2026-10-12", null],
      ["Acme", "2026-10-17", "Demo"],
    ]);
    expect(selectDealsDue(pipelines, "2026-10-17", true).map((deal) => deal.title)).toEqual(["Globex", "Acme", "Hooli"]);
  });
});

describe("pipelines deals-due", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GSAM_API_KEY;
    delete process.env.GSAM_API_URL;
  });

  it("reads only the Pipedrive deal pipelines and prints the deals due", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(`/companies/${COMPANY_ID}/pipelines`)) {
        return jsonResponse([
          { id: "pd", key: "pipedrive-1", name: "DevTools" },
          { id: "leads", key: "pipedrive-leads", name: "Leads" },
          { id: "dx", key: "client", name: "Client journey" },
        ]);
      }
      return jsonResponse([
        {
          case: { id: CASE_ID, caseKey: "acme", title: "Acme", pipelineId: "pd", stageId: "s", version: 1, fields: { dealStatus: "Open", nextActivityDate: "2020-01-01", nextActivitySubject: "Call" } },
          stage: { id: "s", key: "s", name: "Qualified", kind: "working", position: 0 },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["pipelines", "deals-due"]);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `http://localhost:3100/api/companies/${COMPANY_ID}/pipelines`,
      "http://localhost:3100/api/pipelines/pd/cases",
    ]);
    expect(String(log.mock.calls[0]?.[0])).toContain("2020-01-01  Acme: Call");
  });
});

describe("completeDealNextStep", () => {
  it("moves the next step to the last activity and books the follow-up", () => {
    expect(completeDealNextStep(
      { dealStatus: "open", nextActivityDate: "2026-10-15", nextActivitySubject: "Demo", lastActivityNote: "old" },
      { note: " Went well ", nextDate: "2026-10-22", nextSubject: "Send proposal" },
      "2026-10-18",
    )).toEqual({
      dealStatus: "open",
      lastActivityDate: "2026-10-18",
      lastActivitySubject: "Demo",
      lastActivityNote: "Went well",
      nextActivityDate: "2026-10-22",
      nextActivitySubject: "Send proposal",
    });
    expect(completeDealNextStep({ dealStatus: "open", nextActivityDate: "2026-10-15" }, {}, "2026-10-18")).toEqual({
      dealStatus: "open",
      lastActivityDate: "2026-10-18",
    });
  });

  it("sends the updated fields with the case version", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        case: { id: CASE_ID, title: "Acme", version: 7, fields: { dealStatus: "open", nextActivityDate: "2026-10-15", nextActivitySubject: "Call" } },
        stage: { kind: "working" },
      }))
      .mockResolvedValueOnce(jsonResponse({ case: { id: CASE_ID } }));
    vi.stubGlobal("fetch", fetchMock);
    await run(["pipelines", "case", "next-step-done", CASE_ID, "--note", "Spoke to Sam", "--next-date", "2026-10-25"]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/cases/${CASE_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.expectedVersion).toBe(7);
    expect(body.fields).toMatchObject({ lastActivitySubject: "Call", lastActivityNote: "Spoke to Sam", nextActivityDate: "2026-10-25" });
    expect(body.fields.nextActivitySubject).toBeUndefined();
  });
});

