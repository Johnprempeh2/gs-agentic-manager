import { describe, expect, it } from "vitest";
import {
  BLOCKED_WITHOUT_REASON_MESSAGE,
  createAcceptedPlanDecompositionSchema,
  createChildIssueSchema,
  createIssueSchema,
  describeUnknownIssueFields,
  updateIssueSchema,
} from "./issue.js";

// GRE-2329: no mystery blocks. A misspelt field is refused, not dropped, and a
// task cannot be created blocked with nothing blocking it.
const BLOCKER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe("issue body validators refuse unknown fields", () => {
  it("refuses blockedByIds on create and names the right field", () => {
    const result = createIssueSchema.safeParse({
      title: "Wait on the release",
      status: "blocked",
      blockedByIds: [BLOCKER_ID],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["blockedByIds"],
    });
    expect(messages(result)).toContain(
      'Unknown issue field: "blockedByIds" (did you mean blockedByIssueIds?)',
    );
  });

  it("refuses blockedByIds on update instead of returning no changes", () => {
    const result = updateIssueSchema.safeParse({ blockedByIds: [BLOCKER_ID] });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      'Unknown issue field: "blockedByIds" (did you mean blockedByIssueIds?)',
    );
  });

  it("refuses unknown fields on child create and plan children", () => {
    expect(
      messages(createChildIssueSchema.safeParse({ title: "Child", status: "todo", colour: "red" })),
    ).toContain('Unknown issue field: "colour"');
    const plan = createAcceptedPlanDecompositionSchema.safeParse({
      acceptedPlanRevisionId: BLOCKER_ID,
      children: [{ title: "Child", status: "todo", blockedBy: [BLOCKER_ID] }],
    });
    expect(plan.success).toBe(false);
  });

  it("lists every unknown field in one message", () => {
    expect(describeUnknownIssueFields(["blockers", "foo"])).toBe(
      'Unknown issue fields: "blockers" (did you mean blockedByIssueIds?), "foo"',
    );
  });

  it("still accepts the documented update fields", () => {
    expect(
      updateIssueSchema.safeParse({
        status: "in_review",
        comment: "Ready for review",
        blockedByIssueIds: [],
        reopen: false,
        resume: true,
        keyTask: true,
      }).success,
    ).toBe(true);
  });
});

describe("blocked needs a reason on create", () => {
  it("refuses a new blocked task with no blocker and no unblock descriptor", () => {
    const result = createIssueSchema.safeParse({ title: "Mystery", status: "blocked" });
    expect(result.success).toBe(false);
    expect(messages(result)).toEqual([BLOCKED_WITHOUT_REASON_MESSAGE]);
    expect(BLOCKED_WITHOUT_REASON_MESSAGE).toMatch(/^Say what is blocking it/);
  });

  it("refuses an empty blocker list", () => {
    const result = createIssueSchema.safeParse({
      title: "Mystery",
      status: "blocked",
      blockedByIssueIds: [],
    });
    expect(messages(result)).toEqual([BLOCKED_WITHOUT_REASON_MESSAGE]);
  });

  it("refuses a blocked child with no reason", () => {
    const result = createChildIssueSchema.safeParse({ title: "Mystery child", status: "blocked" });
    expect(messages(result)).toEqual([BLOCKED_WITHOUT_REASON_MESSAGE]);
  });

  it("accepts a blocked task that names the tasks it waits on", () => {
    expect(
      createIssueSchema.safeParse({
        title: "Wait on the release",
        status: "blocked",
        blockedByIssueIds: [BLOCKER_ID],
      }).success,
    ).toBe(true);
  });

  it("accepts a blocked task that says who must act", () => {
    expect(
      createIssueSchema.safeParse({
        title: "Wait on a person",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: AGENT_ID }, action: "Merge PR #1" },
      }).success,
    ).toBe(true);
  });

  it("does not touch tasks created in other statuses", () => {
    expect(createIssueSchema.safeParse({ title: "Plain", status: "todo" }).success).toBe(true);
    expect(createIssueSchema.safeParse({ title: "Defaulted" }).success).toBe(true);
  });
});
