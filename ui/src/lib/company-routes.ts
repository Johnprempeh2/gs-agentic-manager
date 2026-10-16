const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "companies",
  "company",
  "skills",
  "teams-catalog",
  "org",
  "agents",
  "chats",
  "messages",
  "apps",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "tasks",
  "routines",
  "workflows",
  "goals",
  "releases",
  "artifacts",
  "deliverables",
  "images",
  "tools",
  "approvals",
  "costs",
  "usage",
  "activity",
  "audit",
  "decisions",
  "deep-dive",
  "my-tasks",
  "needed",
  "inbox",
  "board-chat",
  "u",
  "design-guide",
  "search",
  "settings",
  "timeline",
  "since-last-visit",
  "calendar",
  "scorecard",
  "weekly-report",
  "notifications",
  "morning",
  // Every root mounted under /:companyPrefix must be listed, or a link to it is
  // mistaken for an already-prefixed path and left bare (GRE: /strategy-board
  // became the "STRATEGY-BOARD" company and broke every sidebar link after it).
  "strategy-board",
  "pipelines",
  "organisations",
  "billing",
  "intelligence",
  "review-queue",
  "learnings",
  "cases",
  "status",
  "status-cards",
  "memory",
  "website",
  "tutorials",
  "intelligence",
  "runs",
  "budgets",
  "plugins",
  "dev",
]);

/**
 * Board roots a bare link can start with (/inbox/mine, /morning): each is
 * redirected to the same path under the selected company. Upper-case roots are
 * left out so a company prefix is never mistaken for one.
 */
export const UNPREFIXED_BOARD_ROOTS: readonly string[] = [...BOARD_ROUTE_ROOTS].filter(
  (root) => root === root.toLowerCase(),
);

const GLOBAL_ROUTE_ROOTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs", "instance"]);

export function normalizeCompanyPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractCompanyPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
    return null;
  }
  return normalizeCompanyPrefix(segments[0]!);
}

export function applyCompanyPrefix(path: string, companyPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!companyPrefix) return path;

  const prefix = normalizeCompanyPrefix(companyPrefix);
  const activePrefix = extractCompanyPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

/**
 * Build a company-prefixed href for an experimental Cases route, e.g.
 * `caseHref("PAP", "PAP-C5")` → `/PAP/cases/PAP-C5`.
 *
 * Case paths carry identifiers like `PAP-C5` in the first segment, which the
 * generic {@link applyCompanyPrefix} mistakes for a company prefix ("CASES") and
 * therefore leaves `/cases/...` unprefixed — every case link then only resolves
 * via the PAP-13002 unprefixed→prefixed redirect. This builder emits the
 * prefixed href directly so case-to-case navigation matches the rest of the app.
 * Falls back to the unprefixed path (still valid via the redirect) when no
 * company is active.
 */
export function caseHref(
  companyPrefix: string | null | undefined,
  ...segments: string[]
): string {
  const suffix = ["cases", ...segments].filter(Boolean).join("/");
  if (!companyPrefix) return `/${suffix}`;
  return `/${normalizeCompanyPrefix(companyPrefix)}/${suffix}`;
}

export function toCompanyRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
