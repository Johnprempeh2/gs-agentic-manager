import { afterEach, describe, expect, it, vi } from "vitest";
import { ISSUE_WORK_MODES } from "@greatstone/shared";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const ROUND = "5b0c3d1e-2f4a-4b6c-8d9e-0a1b2c3d4e5f";
const UNIT = "6c1d4e2f-3a5b-4c7d-9e0f-1b2c3d4e5f60";
const API = "http://gsam.test/api";

function call(name: string, args: Record<string, unknown>) {
  return callProjectTool({ name, arguments: args, apiUrl: API, token: "t", companyId: "c1", issueId: "i1", agentId: "a1", conversation: false });
}

// GRE-2667: agents read a round's status and synthesis and draft question sets. Approving a set, deciding a
// proposal, releasing and withdrawing are a person's actions: no tool exists for them, and none of these tools
// calls their routes.
describe("Parallel Interview agent tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers read, read and draft only: nothing that approves, decides, releases or withdraws", () => {
    for (const mode of ISSUE_WORK_MODES) {
      const names = projectToolDefinitions(mode, true).map((tool) => tool.name);
      expect(names.filter((name) => /approv|decid|decision|releas|withdraw|publish/.test(name)), mode).toEqual([]);
    }
    const tools = projectToolDefinitions("standard").filter((tool) => tool.name.startsWith("interview_"));
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ["interview_round_get", true],
      ["interview_synthesis_get", true],
      ["interview_set_draft", false],
    ]);
  });

  it("refuses a tool name it does not have", async () => {
    vi.stubGlobal("fetch", vi.fn());
    for (const name of ["interview_set_approve", "interview_synthesis_release", "interview_synthesis_withdraw", "interview_proposal_decide"]) {
      await expect(call(name, { roundId: ROUND })).rejects.toThrow(/Unknown project tool/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads status and synthesis with GETs only, and keeps names and emails out of the status", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/interview-round")) return Response.json({ round: { id: ROUND, status: "open", sets: [] }, available: [] });
      if (url.endsWith("/progress")) return Response.json({ roundId: ROUND, total: 1, counts: { invited: 1 }, people: [{ name: "A Person", email: "a@example.com" }] });
      if (url.endsWith("/proposals")) return Response.json({ roundId: ROUND, proposals: [] });
      return Response.json({ roundId: ROUND, released: null, readiness: { ready: false, blockers: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await call("interview_round_get", {});
    expect(JSON.stringify(status)).not.toContain("a@example.com");
    expect(status).toMatchObject({ round: { id: ROUND, status: "open" }, progress: { total: 1 }, release: { released: null } });
    const synthesis = await call("interview_synthesis_get", { roundId: ROUND });
    expect(synthesis).toMatchObject({ proposals: [], release: { readiness: { ready: false } } });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API}/companies/c1/deep-dive/interview-round`,
      `${API}/companies/c1/deep-dive/interview-round/progress`,
      `${API}/deep-dive/interview-rounds/${ROUND}/synthesis/release`,
      `${API}/deep-dive/interview-rounds/${ROUND}/synthesis/proposals`,
      `${API}/deep-dive/interview-rounds/${ROUND}/synthesis/release`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  });

  it("drafts a set through the draft route and nothing else", async () => {
    const fetchMock = vi.fn(async () => Response.json({ round: { id: ROUND, sets: [{ status: "draft" }] } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const drafted = await call("interview_set_draft", { roundId: ROUND, unitId: UNIT });
    expect(drafted).toMatchObject({ round: { sets: [{ status: "draft" }] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect([url, init.method, JSON.parse(String(init.body))]).toEqual([`${API}/deep-dive/interview-rounds/${ROUND}/sets`, "POST", { unitId: UNIT }]);

    // An approval or a status cannot ride along.
    await expect(call("interview_set_draft", { roundId: ROUND, unitId: UNIT, status: "approved" })).rejects.toThrow();
    await expect(call("interview_set_draft", { roundId: ROUND })).rejects.toThrow(/unitId or a personId/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
