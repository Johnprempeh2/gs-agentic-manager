import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerProjectCommands } from "../commands/client/project.js";
import { registerWorkflowCommands } from "../commands/client/workflow.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerProjectCommands(program);
  registerGoalCommands(program);
  registerWorkflowCommands(program);
  return program;
}

describe("project and goal commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.GSAM_API_KEY;
    delete process.env.GSAM_API_URL;
    delete process.env.GSAM_COMPANY_ID;
    process.env.GSAM_CONTEXT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-project-goal-")), "context.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GSAM_CONTEXT;
  });

  it("creates and updates projects with shared schemas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "planned",
        goalIds: [GOAL_ID],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Launch Site",
        status: "in_progress",
        goalIds: [GOAL_ID],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--name", "Launch Site",
      "--status", "planned",
      "--goal-ids", GOAL_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "update", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--status", "in_progress",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "Launch Site",
      status: "planned",
      goalIds: [GOAL_ID],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
  });

  it("lists and deletes projects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site", status: "planned", goalIds: [] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: PROJECT_ID, companyId: COMPANY_ID, name: "Launch Site" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "project", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "project", "delete", PROJECT_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/projects`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/projects/${PROJECT_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("creates, updates, lists, and deletes goals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow", level: "company", status: "active" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster", level: "company", status: "active" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: GOAL_ID, companyId: COMPANY_ID, title: "Grow faster" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "goal", "create",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--title", "Grow",
      "--level", "company",
      "--status", "active",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "update", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--title", "Grow faster",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "delete", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--yes",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/goals`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });

  it("posts and lists goal check-ins", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ci1", body: "Shipped the page" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "ci1", body: "Shipped the page", progressPercent: 40, createdAt: "2026-10-18" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "goal", "check-in", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--body", "Shipped the page",
      "--progress", "40",
      "--blocker", "Waiting on copy",
      "--blocker", "No budget for ads",
    ], { from: "user" });

    await createProgram().parseAsync([
      "goal", "check-ins", GOAL_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}/check-ins`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      body: "Shipped the page",
      progressPercent: 40,
      blockers: ["Waiting on copy", "No budget for ads"],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}/check-ins`);
  });

  it("records and lists KPI readings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "r1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "r1", value: 12, readingDate: "2026-10-17", source: "agent_verified", note: null }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const base = ["--api-base", "http://localhost:3100", "--api-key", "board-token"];

    await createProgram().parseAsync(["goal", "reading", GOAL_ID, ...base, "--value", "12", "--date", "2026-10-17", "--source", "agent_verified"], { from: "user" });
    await createProgram().parseAsync(["goal", "readings", GOAL_ID, ...base], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}/readings`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ value: 12, readingDate: "2026-10-17", source: "agent_verified" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/goals/${GOAL_ID}/readings`);
  });

  it("lists and starts saved workflows", async () => {
    const TEMPLATE_ID = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: TEMPLATE_ID, key: "launch", name: "Launch", definition: { steps: [{}, {}] } }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ coordinator: { id: "i1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const base = ["--api-base", "http://localhost:3100", "--api-key", "board-token"];

    await createProgram().parseAsync(["workflow", "list", ...base, "--company-id", COMPANY_ID], { from: "user" });
    await createProgram().parseAsync(["workflow", "start", TEMPLATE_ID, ...base, "--title", "Launch for Acme", "--project-id", PROJECT_ID], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/workflow-templates`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/workflow-templates/${TEMPLATE_ID}/start`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ title: "Launch for Acme", projectId: PROJECT_ID });
  });
});
