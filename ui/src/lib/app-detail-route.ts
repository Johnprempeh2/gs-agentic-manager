/**
 * Fixed `/apps/<segment>` routes in `App.tsx`. Any other segment is a tool
 * connection id (`apps/:connectionId`), so the layout loads that connection
 * for the app detail sidebar. Keep this in step with the routes, or the
 * layout calls `GET /api/tool-connections/<segment>` and gets a 404
 * (GRE-1435: `mailboxes` was missing).
 */
export const RESERVED_APP_SUBPATHS: ReadonlySet<string> = new Set([
  "access",
  "advanced",
  "app",
  "attention",
  "browse",
  "byo",
  "chat",
  "connect",
  "connections",
  "gateways",
  "mailboxes",
  "review",
  "vercel-connect",
]);

/** Connection id from company path segments such as `["apps", "<id>", "permissions"]`, else null. */
export function getAppDetailConnectionId(companyPathSegments: readonly string[]): string | null {
  if (companyPathSegments[0]?.toLowerCase() !== "apps") return null;
  const segment = companyPathSegments[1];
  if (!segment || RESERVED_APP_SUBPATHS.has(segment.toLowerCase())) return null;
  return segment;
}
