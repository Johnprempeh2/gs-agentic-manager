import { describe, expect, it } from "vitest";
import { buildWaitingDescriptor } from "./waiting-date";

describe("buildWaitingDescriptor", () => {
  it("makes the assignee the owner of a new note", () => {
    expect(buildWaitingDescriptor({ assigneeAgentId: "agent-1" }, "client", "2026-10-24")).toEqual({
      owner: { agentId: "agent-1" },
      action: "Hear back from the client.",
      waitingOn: "client",
      expectedBy: "2026-10-24",
    });
  });

  it("falls back to the board when nobody is assigned", () => {
    expect(buildWaitingDescriptor({ assigneeAgentId: null }, "outside", null)).toEqual({
      owner: "board",
      action: "Hear back from outside the company.",
      waitingOn: "outside",
    });
  });

  it("keeps the owner and words of a note already there and drops a stale wake marker", () => {
    const descriptor = buildWaitingDescriptor(
      {
        assigneeAgentId: "agent-1",
        unblockDescriptor: {
          owner: { userId: "user-1" },
          action: "Ben sends the signed NDA",
          waitingOn: "board",
          expectedBy: "2026-10-10",
          expectedByWokenFor: "2026-10-10",
        },
      },
      "client",
      "2026-10-31",
    );
    expect(descriptor).toEqual({
      owner: { userId: "user-1" },
      action: "Ben sends the signed NDA",
      waitingOn: "client",
      expectedBy: "2026-10-31",
    });
  });
});
