import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityApi } from "@/api/activity";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { issueRefFromPath } from "./issue-detail-page";
import { prefetchColdIssueDetail } from "./issueDetailCache";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(() => new Promise(() => {})),
    listComments: vi.fn(() => new Promise(() => {})),
    getTree: vi.fn(() => new Promise(() => {})),
    listInteractions: vi.fn(() => new Promise(() => {})),
    listAttachments: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock("@/api/activity", () => ({
  activityApi: {
    forIssue: vi.fn(() => new Promise(() => {})),
    runsForIssue: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForIssue: vi.fn(() => new Promise(() => {})),
  },
}));

describe("issueRefFromPath", () => {
  it("reads the task ref with or without a company prefix", () => {
    expect(issueRefFromPath("/GRE/issues/GRE-12")).toBe("GRE-12");
    expect(issueRefFromPath("/issues/GRE-12/")).toBe("GRE-12");
    expect(issueRefFromPath("/GRE/issues/a%20b")).toBe("a b");
  });

  it("ignores other pages and task sub-pages", () => {
    expect(issueRefFromPath("/GRE/dashboard")).toBeNull();
    expect(issueRefFromPath("/GRE/issues")).toBeNull();
    expect(issueRefFromPath("/GRE/issues/GRE-12/tree")).toBeNull();
    expect(issueRefFromPath("/GRE/issues/%E0%A4%A")).toBeNull();
  });
});

describe("prefetchColdIssueDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts the task, first comments and tree under the page's own keys", () => {
    const queryClient = new QueryClient();
    expect(prefetchColdIssueDetail(queryClient, { pathname: "/GRE/issues/GRE-12", search: "", hash: "" })).toBe(true);
    expect(issuesApi.get).toHaveBeenCalledWith("GRE-12");
    expect(issuesApi.listComments).toHaveBeenCalledWith("GRE-12", { order: "desc", limit: expect.any(Number) });
    expect(issuesApi.getTree).toHaveBeenCalledWith("GRE-12");
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.detail("GRE-12") })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.comments("GRE-12") })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issueTree("GRE-12") })).toBeDefined();
  });

  it("starts the thread history with the task, so the thread does not wait for its own mount (GRE-5821)", async () => {
    vi.mocked(issuesApi.get).mockResolvedValueOnce({ id: "issue-uuid", identifier: "GRE-12" } as never);
    const queryClient = new QueryClient();
    prefetchColdIssueDetail(queryClient, { pathname: "/GRE/issues/GRE-12", search: "", hash: "" });
    // Interactions and attachments are keyed by the route ref, like the page.
    expect(issuesApi.listInteractions).toHaveBeenCalledWith("GRE-12");
    expect(issuesApi.listAttachments).toHaveBeenCalledWith("GRE-12");
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.interactions("GRE-12") })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.attachments("GRE-12") })).toBeDefined();
    // Activity and runs are keyed by the task id, known once the task is in.
    await vi.waitFor(() => expect(activityApi.forIssue).toHaveBeenCalledWith("issue-uuid"));
    expect(activityApi.runsForIssue).toHaveBeenCalledWith("issue-uuid");
    expect(heartbeatsApi.liveRunsForIssue).toHaveBeenCalledWith("issue-uuid");
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.activity("issue-uuid") })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.runs("issue-uuid") })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.issues.liveRuns("issue-uuid") })).toBeDefined();
  });

  it("does not ask for run history when the task does not load", async () => {
    vi.mocked(issuesApi.get).mockRejectedValueOnce(new Error("not found"));
    prefetchColdIssueDetail(new QueryClient(), { pathname: "/GRE/issues/GRE-12", search: "", hash: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityApi.forIssue).not.toHaveBeenCalled();
  });

  it("skips the tree when the link already asks for the task page", () => {
    prefetchColdIssueDetail(new QueryClient(), { pathname: "/GRE/issues/GRE-12", search: "?view=task", hash: "" });
    prefetchColdIssueDetail(new QueryClient(), { pathname: "/GRE/issues/GRE-12", search: "", hash: "#comment-1" });
    expect(issuesApi.get).toHaveBeenCalledTimes(2);
    expect(issuesApi.getTree).not.toHaveBeenCalled();
  });

  it("does nothing on other pages", () => {
    expect(prefetchColdIssueDetail(new QueryClient(), { pathname: "/GRE/dashboard", search: "", hash: "" })).toBe(false);
    expect(issuesApi.get).not.toHaveBeenCalled();
  });
});
