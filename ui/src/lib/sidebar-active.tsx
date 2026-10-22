import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

/**
 * One lit row in the sidebar. Several rows can point at the same page (the
 * Desk and Decisions; Tasks, a pinned task and the same task under Recent; a
 * chat task and its agent's chat row), so a route lists the rows that could
 * stand for it, most specific first, and the first row actually on screen wins.
 */

export interface SidebarActiveIssue {
  id: string;
  identifier?: string | null;
  conversationAgentId?: string | null;
}

/** Board path without its company prefix ("/issues/NOR-1"), its hash, and the open task when there is one. */
export function sidebarActiveCandidates(path: string, hash: string, issue?: SidebarActiveIssue | null): string[] | null {
  if (/^\/desk\/?$/.test(path)) {
    return hash === "#desk-needs-me" ? ["item:decisions", "item:my-tasks"] : ["item:my-tasks", "item:decisions"];
  }
  if (/^\/decisions\/focus\/?$/.test(path)) return ["item:decisions", "item:my-tasks"];

  const chat = path.match(/^\/chats\/([^/]+)/);
  if (chat) return [`chat:${decodeURIComponent(chat[1]!)}`];

  const task = path.match(/^\/issues\/([^/]+)/);
  if (task && task[1] !== "new") {
    const refs = [...new Set([task[1]!, issue?.identifier, issue?.id].filter((ref): ref is string => Boolean(ref)))];
    return [
      ...(issue?.conversationAgentId ? [`chat:${issue.conversationAgentId}`] : []),
      ...refs.map((ref) => `pinned:${ref}`),
      ...refs.map((ref) => `recent:${ref}`),
      "item:tasks",
    ];
  }

  const project = path.match(/^\/projects\/([^/]+)/);
  if (project) return [`project:${decodeURIComponent(project[1]!)}`, "item:projects"];

  return null;
}

interface SidebarActiveValue {
  candidates: string[] | null;
  winner: string | null;
  register: (keys: string[]) => () => void;
}

const SidebarActiveContext = createContext<SidebarActiveValue | null>(null);

export function SidebarActiveProvider({ candidates, children }: { candidates: string[] | null; children: ReactNode }) {
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  // Stable, so a row registers once per mount and not on every change.
  const register = useCallback((keys: string[]) => {
    const bump = (by: number) => setShown((prev) => {
      const next = new Map(prev);
      for (const key of keys) next.set(key, (next.get(key) ?? 0) + by);
      return next;
    });
    bump(1);
    return () => bump(-1);
  }, []);
  const value = useMemo<SidebarActiveValue>(() => ({
    candidates,
    winner: candidates?.find((key) => (shown.get(key) ?? 0) > 0) ?? null,
    register,
  }), [candidates, shown, register]);
  return <SidebarActiveContext.Provider value={value}>{children}</SidebarActiveContext.Provider>;
}

/**
 * Whether the row standing for `keys` is the lit one. Undefined outside the
 * main sidebar, or on a page no two rows compete for: the row then keeps its
 * own route matching.
 */
export function useSidebarActive(keys: string[] | undefined): boolean | undefined {
  const ctx = useContext(SidebarActiveContext);
  const register = ctx?.register;
  const joined = keys?.join("\n") ?? "";
  useLayoutEffect(() => {
    if (!register || !joined) return;
    return register(joined.split("\n"));
  }, [register, joined]);
  if (!ctx || !keys?.length || !ctx.candidates) return undefined;
  return ctx.winner !== null && keys.includes(ctx.winner);
}
