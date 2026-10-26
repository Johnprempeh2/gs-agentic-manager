import { useEffect } from "react";

type IssueDetailPageModule = typeof import("../pages/IssueDetail");

let loadedModule: IssueDetailPageModule | undefined;
let pending: Promise<unknown> | null = null;

/**
 * The task page is its own download (page split, 16 Oct), and it pulls in
 * about 120 smaller files. Fetching them only on click put ~250 ms in front of
 * every open from a list (GRE-2761), so lists fetch them once they are idle,
 * hover and focus fetch them early, and a cold task URL starts them at boot.
 */
export const loadIssueDetailPage = () =>
  import("../pages/IssueDetail").then((module) => (loadedModule = module));

/** The page module once a load has finished, so the route can render without suspending. */
export const loadedIssueDetailPage = () => loadedModule;

export const isIssueDetailPageLoaded = () => loadedModule !== undefined;

export function preloadIssueDetailPage(): void {
  // Unit tests hover links all the time; they must not pull the whole page in.
  if (import.meta.env.MODE === "test") return;
  pending ??= loadIssueDetailPage().catch(() => {
    // A failed preload is retried by the route itself on click.
    pending = null;
  });
}

const ISSUE_DETAIL_PATH = /^(?:\/[^/]+)?\/issues\/[^/]+\/?$/;

export function isIssueDetailPath(pathname: string): boolean {
  return ISSUE_DETAIL_PATH.test(pathname);
}

/**
 * Fetch the task page right after the caller's list has painted. Waiting for
 * an idle moment was too late: a quick click still beat it.
 */
export function usePreloadIssueDetailPageAfterPaint(ready: boolean): void {
  useEffect(() => {
    if (!ready || pending) return;
    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timeout = window.setTimeout(preloadIssueDetailPage, 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [ready]);
}
