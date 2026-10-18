import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalAgeDays, registerApprovalCommands } from "../commands/client/approval.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerApprovalCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("approval commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GSAM_API_KEY;
    delete process.env.GSAM_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows each approval's age and filters to the stale ones", async () => {
    const day = 86_400_000;
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse([
        { id: "old", type: "hire_agent", status: "pending", createdAt: new Date(Date.now() - 5.5 * day).toISOString() },
        { id: "new", type: "hire_agent", status: "pending", createdAt: new Date().toISOString() },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["approval", "list", "-C", COMPANY_ID, "--older-than", "3"]);

    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("old");
    expect(lines[0]).toContain("ageDays=5");
  });

  it("lists the tasks linked to an approval", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse([{ id: "i1", identifier: "GRE-1", title: "Hire a writer", status: "blocked" }])),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["approval", "issues", APPROVAL_ID]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/issues`);
  });

  it("counts whole days waited", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(approvalAgeDays("2026-10-16T13:00:00Z", now)).toBe(1);
    expect(approvalAgeDays("not a date", now)).toBe(0);
  });
});
