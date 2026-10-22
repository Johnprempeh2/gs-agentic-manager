// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarActiveProvider, sidebarActiveCandidates, useSidebarActive } from "./sidebar-active";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("sidebarActiveCandidates", () => {
  it("lets the hash choose between the Desk and Decisions, and Focus lights Decisions", () => {
    expect(sidebarActiveCandidates("/desk", "")?.[0]).toBe("item:my-tasks");
    expect(sidebarActiveCandidates("/desk", "#desk-needs-me")?.[0]).toBe("item:decisions");
    expect(sidebarActiveCandidates("/decisions/focus", "")?.[0]).toBe("item:decisions");
  });

  it("puts a chat task's agent first, then its pin, then Recent, then Tasks", () => {
    expect(sidebarActiveCandidates("/issues/NOR-34", "", { id: "i34", identifier: "NOR-34", conversationAgentId: "a1" })).toEqual([
      "chat:a1",
      "pinned:NOR-34", "pinned:i34",
      "recent:NOR-34", "recent:i34",
      "item:tasks",
    ]);
    // The tree of a task is the same task.
    expect(sidebarActiveCandidates("/issues/NOR-1/tree", "", null)).toEqual(["pinned:NOR-1", "recent:NOR-1", "item:tasks"]);
    expect(sidebarActiveCandidates("/issues/new", "")).toBeNull();
  });

  it("covers chats and project pages, and leaves every other page to its own row", () => {
    expect(sidebarActiveCandidates("/chats/everest", "")).toEqual(["chat:everest"]);
    expect(sidebarActiveCandidates("/projects/client-portal/tree", "")).toEqual(["project:client-portal", "item:projects"]);
    expect(sidebarActiveCandidates("/activity/timeline", "")).toBeNull();
  });
});

function Row({ name, keys }: { name: string; keys: string[] }) {
  const lit = useSidebarActive(keys);
  return <span data-row={name} data-lit={lit === undefined ? "own" : String(lit)} />;
}

describe("SidebarActiveProvider", () => {
  let root: Root | null = null;
  const container = document.createElement("div");
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });
  const render = (candidates: string[] | null, rows: Array<[string, string[]]>) => {
    root ??= createRoot(container);
    act(() => root!.render(
      <SidebarActiveProvider candidates={candidates}>
        {rows.map(([name, keys]) => <Row key={name} name={name} keys={keys} />)}
      </SidebarActiveProvider>,
    ));
    return Object.fromEntries([...container.querySelectorAll("[data-row]")].map((el) => [el.getAttribute("data-row"), el.getAttribute("data-lit")]));
  };

  it("lights exactly one row: the most specific one on screen", () => {
    const tasks: [string, string[]] = ["Tasks", ["item:tasks"]];
    const recent: [string, string[]] = ["Recent", ["recent:i34", "recent:NOR-34"]];
    const chat: [string, string[]] = ["Everest", ["chat:a1", "chat:everest"]];
    const candidates = sidebarActiveCandidates("/issues/NOR-34", "", { id: "i34", identifier: "NOR-34", conversationAgentId: "a1" });
    expect(render(candidates, [tasks, recent, chat])).toEqual({ Tasks: "false", Recent: "false", Everest: "true" });
    // Without the chat row on screen, the Recent row stands for the task.
    expect(render(candidates, [tasks, recent])).toEqual({ Tasks: "false", Recent: "true" });
    // A task only Tasks knows: Tasks.
    expect(render(candidates, [tasks])).toEqual({ Tasks: "true" });
  });

  it("leaves rows to their own route match on pages nothing competes for", () => {
    expect(render(null, [["Tasks", ["item:tasks"]]])).toEqual({ Tasks: "own" });
  });
});
