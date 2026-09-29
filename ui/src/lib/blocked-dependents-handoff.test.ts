import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import {
  BLOCKED_DEPENDENTS_CONFLICT_CODE,
  isBlockedDependentsHandoffCancelled,
  readBlockedDependentsConflict,
  registerBlockedDependentsHandler,
  type BlockedDependentsHandler,
} from "./blocked-dependents-handoff";

const dependents = [
  { id: "dep-1", identifier: "GRE-2", title: "Wire the board", status: "todo" },
  { id: "dep-2", identifier: "GRE-3", title: "Write docs", status: "blocked" },
];

const blockedDependentsConflict = {
  error: "GRE-1 still blocks open tasks: GRE-2 (todo), GRE-3 (blocked).",
  code: BLOCKED_DEPENDENTS_CONFLICT_CODE,
  details: { code: BLOCKED_DEPENDENTS_CONFLICT_CODE, dependents, options: ["move", "remove"] },
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let unregister: (() => void) | null = null;

function sentBodies() {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function useHandler(handler: BlockedDependentsHandler) {
  const spy = vi.fn(handler);
  unregister = registerBlockedDependentsHandler(spy);
  return spy;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

describe("issuesApi.update blocked-dependents handoff (GRE-235)", () => {
  it("asks the dialog with the dependents and re-sends the cancel with a move", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, blockedDependentsConflict))
      .mockResolvedValueOnce(jsonResponse(200, { id: "issue-1", status: "cancelled" }));
    const handler = useHandler(async () => ({ action: "move", issueId: "kept-1" }));

    const result = await issuesApi.update("issue-1", { status: "cancelled" });

    expect(handler).toHaveBeenCalledWith({ issueId: "issue-1", dependents });
    expect(sentBodies()).toEqual([
      { status: "cancelled" },
      { status: "cancelled", blockedDependents: { action: "move", issueId: "kept-1" } },
    ]);
    expect(result).toMatchObject({ id: "issue-1", status: "cancelled" });
  });

  it("re-sends the cancel with remove", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, blockedDependentsConflict))
      .mockResolvedValueOnce(jsonResponse(200, { id: "issue-1", status: "cancelled" }));
    useHandler(async () => ({ action: "remove" }));

    await issuesApi.update("issue-1", { status: "cancelled" });

    expect(sentBodies()[1]).toEqual({ status: "cancelled", blockedDependents: { action: "remove" } });
  });

  it("changes nothing when the dialog is closed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, blockedDependentsConflict));
    useHandler(async () => null);

    const error = await issuesApi.update("issue-1", { status: "cancelled" }).catch((err) => err);

    expect(isBlockedDependentsHandoffCancelled(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves other errors unchanged and does not open the dialog", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "Issue is checked out", code: "issue_checkout_conflict" }));
    const handler = useHandler(async () => ({ action: "remove" }));

    const error = await issuesApi.update("issue-1", { status: "cancelled" }).catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Issue is checked out");
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the original 409 when no dialog is mounted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, blockedDependentsConflict));

    const error = await issuesApi.update("issue-1", { status: "cancelled" }).catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(readBlockedDependentsConflict(error)).toEqual(dependents);
  });
});
