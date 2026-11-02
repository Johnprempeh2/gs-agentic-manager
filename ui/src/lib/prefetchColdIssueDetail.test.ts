import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { issueRefFromPath } from "./issue-detail-page";
import { prefetchColdIssueDetail } from "./issueDetailCache";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(() => new Promise(() => {})),
    listComments: vi.fn(() => new Promise(() => {})),
    getTree: vi.fn(() => new Promise(() => {})),
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
