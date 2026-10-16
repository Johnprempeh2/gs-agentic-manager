import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommandPalette } from "@/components/CommandPalette";
import { openCommandPalette } from "@/lib/global-search";
import { storybookIssues } from "../fixtures/paperclipData";

/**
 * Global search (Cmd/Ctrl+K or the Search button on every page): one box
 * across tasks, clients, documents, routines and memory, with quick actions
 * on tasks. The fetch answers below stand in for the server.
 */

const now = new Date().toISOString();

const indagoTasks = [
  { ...storybookIssues[0]!, id: "issue-indago-1", identifier: "GRE-1354", title: "Indago commercial model", status: "in_progress" },
  { ...storybookIssues[1]!, id: "issue-indago-2", identifier: "GRE-1361", title: "Indago deep dive kick-off pack", status: "blocked" },
  { ...storybookIssues[2]!, id: "issue-indago-3", identifier: "GRE-1370", title: "Book Indago discovery workshop", status: "in_review" },
];

const responses: Array<[RegExp, (url: URL) => unknown]> = [
  [/\/api\/companies\/[^/]+\/pipelines$/, () => [
    { id: "pipeline-clients", companyId: "company-storybook", key: "clients", name: "Clients", archivedAt: null },
  ]],
  [/\/api\/pipelines\/pipeline-clients\/cases$/, () => [
    {
      case: { id: "case-indago", pipelineId: "pipeline-clients", stageId: "stage-proposal", title: "Indago Capital", caseKey: "indago", summary: "Deep dive and AI roadmap" },
      stage: { id: "stage-proposal", pipelineId: "pipeline-clients", key: "proposal", name: "Proposal", kind: "open", position: 2 },
    },
  ]],
  [/\/api\/companies\/[^/]+\/search$/, (url) => (url.searchParams.get("scope") === "comments" ? {
    query: "indago",
    results: [
      {
        id: "issue-fee",
        type: "issue",
        score: 1,
        title: "Pricing review for Q4 clients",
        href: "/PAP/issues/GRE-1290",
        matchedFields: ["comment"],
        sourceLabel: null,
        snippet: null,
        snippets: [{ field: "comment", label: "Comment", text: "Indago asked for a fixed fee before they sign", highlights: [] }],
        issue: { id: "issue-fee", identifier: "GRE-1290", title: "Pricing review for Q4 clients", status: "in_progress", priority: "high", assigneeAgentId: null, assigneeUserId: null, projectId: null, updatedAt: now },
        updatedAt: now,
        previewImageUrl: null,
      },
    ],
  } : url.searchParams.get("scope") === "documents" ? { query: "indago", results: [] } : {
    query: "indago",
    results: [
      {
        id: "doc-1",
        type: "artifact",
        score: 1,
        title: "Indago discovery notes",
        href: "/PAP/issues/GRE-1361#document-notes",
        matchedFields: ["title"],
        sourceLabel: "Document",
        snippet: null,
        snippets: [],
        artifact: { id: "doc-1", source: "document", mediaKind: "document", issueId: "issue-indago-2", issueIdentifier: "GRE-1361", issueTitle: "Indago deep dive kick-off pack", projectId: null, projectName: null, updatedAt: now },
        updatedAt: now,
        previewImageUrl: null,
      },
    ],
  })],
  [/\/api\/companies\/[^/]+\/routines$/, () => [
    { id: "routine-1", title: "Weekly Indago status note", description: "Every Friday", status: "active", triggers: [], lastRun: null, activeIssue: null },
  ]],
  [/\/api\/companies\/[^/]+\/memory\/graph$/, () => ({
    note: "",
    nodes: [
      { id: "mem-1", scopeId: "s1", scopeKind: "company", scopeName: "Greatstone", title: "Indago prefers a fixed fee", excerpt: "", status: "active", createdAt: now, updatedAt: now },
    ],
    edges: [],
    scopes: [],
    truncated: false,
  })],
  [/\/api\/companies\/[^/]+\/issues$/, () => indagoTasks],
];

function installSearchFetch() {
  const marker = window as typeof window & { __globalSearchStoryFetch?: boolean };
  if (marker.__globalSearchStoryFetch) return;
  marker.__globalSearchStoryFetch = true;
  const inner = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if ((init?.method ?? "GET").toUpperCase() === "GET") {
      for (const [pattern, body] of responses) {
        if (pattern.test(url.pathname)) return Response.json(body(url));
      }
    }
    return inner(input, init);
  };
}

function OpenPalette({ query }: { query: string }) {
  installSearchFetch();
  useEffect(() => {
    const timer = window.setTimeout(() => openCommandPalette(query), 50);
    return () => window.clearTimeout(timer);
  }, [query]);
  return <CommandPalette />;
}

const meta: Meta<typeof OpenPalette> = {
  title: "Product/Global search",
  component: OpenPalette,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof OpenPalette>;

export const SearchEverything: Story = { args: { query: "indago" } };

export const EmptyBox: Story = {
  args: { query: "" },
  beforeEach: () => {
    window.localStorage.setItem("paperclip:recent-searches:company-storybook", JSON.stringify(["indago fee", "booking module"]));
    window.localStorage.setItem("gsam:saved-searches:company-storybook:user-board", JSON.stringify([
      { id: "view-1", kind: "view", label: "Tasks / Stuck", path: "/issues?status=blocked" },
      { id: "search-1", kind: "search", label: "Indago", query: "Indago" },
    ]));
  },
};

/** "Create a task for CodexCoder…" shows a preview; press Enter on "Do this" to see it. */
export const PlainEnglishCommand: Story = {
  args: { query: "create a task for CodexCoder to tidy the Indago pricing page by Friday" },
};
