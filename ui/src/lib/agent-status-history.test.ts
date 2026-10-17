import { describe, expect, it } from "vitest";
import { agentStatusHistory } from "./agent-status-history";

const event = (id: string, action: string, actorType: string, createdAt: string) =>
  ({ id, action, actorType, createdAt, companyId: "c", actorId: "x", entityType: "agent", entityId: "a", agentId: null, runId: null, details: null }) as never;

describe("agentStatusHistory", () => {
  it("keeps status events, newest first, with who did it", () => {
    const rows = agentStatusHistory([
      event("1", "agent.created", "user", "2026-10-01T09:00:00Z"),
      event("2", "agent.instructions_file_updated", "user", "2026-10-02T09:00:00Z"),
      event("3", "agent.paused", "system", "2026-10-03T09:00:00Z"),
      event("4", "agent.resumed", "user", "2026-10-04T09:00:00Z"),
    ]);
    expect(rows.map((row) => `${row.label} ${row.by}`)).toEqual([
      "Resumed by the board",
      "Paused automatically",
      "Added by the board",
    ]);
  });
});
