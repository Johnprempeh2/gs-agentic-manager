// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { routePreloadFiles, routePreloadScript } from "./vite-route-preload";
import { ISSUE_DETAIL_PATH } from "./issue-detail-path";

const chunk = (fileName: string, imports: string[], extra: { isEntry?: boolean; moduleIds?: string[] } = {}) => ({
  type: "chunk" as const,
  fileName,
  imports,
  isEntry: extra.isEntry ?? false,
  moduleIds: extra.moduleIds ?? [],
});

const bundle = {
  "assets/index.js": chunk("assets/index.js", ["assets/react.js", "assets/icons-a.js"], { isEntry: true, moduleIds: ["/app/src/main.tsx"] }),
  "assets/react.js": chunk("assets/react.js", []),
  "assets/icons-a.js": chunk("assets/icons-a.js", ["assets/react.js"]),
  "assets/IssueDetail.js": chunk("assets/IssueDetail.js", ["assets/react.js", "assets/markdown.js"], { moduleIds: ["/app/src/pages/issue-detail/Sections.tsx", "/app/src/pages/IssueDetail.tsx"] }),
  "assets/markdown.js": chunk("assets/markdown.js", ["assets/icons-a.js", "assets/icons-b.js"]),
  "assets/icons-b.js": chunk("assets/icons-b.js", []),
  "assets/Dashboard.js": chunk("assets/Dashboard.js", ["assets/charts.js"], { moduleIds: ["/app/src/pages/Dashboard.tsx"] }),
  "assets/charts.js": chunk("assets/charts.js", []),
  "index.css": { type: "asset" as const, fileName: "index.css" },
};

describe("routePreloadFiles", () => {
  it("lists the page's files the entry does not already load, page first", () => {
    expect(routePreloadFiles(bundle, "/src/pages/IssueDetail.tsx")).toEqual([
      "assets/IssueDetail.js",
      "assets/markdown.js",
      "assets/icons-b.js",
    ]);
  });

  it("fails the build when the page is missing, rather than shipping no preload", () => {
    expect(() => routePreloadFiles(bundle, "/src/pages/Missing.tsx")).toThrow(/no chunk/);
  });
});

describe("routePreloadScript", () => {
  function linksFor(pathname: string) {
    const script = routePreloadScript([{ path: ISSUE_DETAIL_PATH, files: ["assets/IssueDetail.js", "assets/markdown.js"] }], "/");
    document.head.innerHTML = "";
    const body = script.replace(/^<script>/, "").replace(/<\/script>$/, "");
    new Function("location", body)({ pathname });
    return [...document.head.querySelectorAll<HTMLLinkElement>("link[rel=modulepreload]")].map((link) => link.getAttribute("href"));
  }

  it("preloads the task page only on a task URL", () => {
    expect(linksFor("/GRE/issues/GRE-12")).toEqual(["/assets/IssueDetail.js", "/assets/markdown.js"]);
    expect(linksFor("/GRE/dashboard")).toEqual([]);
    expect(linksFor("/GRE/issues/GRE-12/tree")).toEqual([]);
  });
});
