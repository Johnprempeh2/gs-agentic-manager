import { describe, expect, it } from "vitest";
import type { toolConnections } from "@greatstone/db";
import { APP_DEFINITIONS } from "@greatstone/shared";
import { instanceClientTokenUrlAllowed } from "../services/tool-access.js";

// Ported from upstream ba1b0585b (server/src/services/tool-access/oauth/client-settings.test.ts).
// The rule decides whether a deployment-wide GSAM_TOOL_OAUTH_* client may be
// sent to a token URL. The env lookup and the token exchange are covered in
// tool-access-service.test.ts and generic-mcp-connection.test.ts.

type Connection = typeof toolConnections.$inferSelect;

function connection(config: Record<string, unknown>): Connection {
  return {
    id: "connection-1",
    companyId: "company-1",
    transport: "mcp_remote",
    config,
    transportConfig: {},
    credentialSecretRefs: [],
  } as unknown as Connection;
}

const slack = (oauth: Record<string, unknown> = {}) =>
  connection({ sourceTemplateKey: "slack", connectionMethodKey: "mcp-oauth", oauth });
const generic = (oauth: Record<string, unknown> = {}) =>
  connection({ url: "https://mcp.example.test/mcp", oauth });

describe("deployment OAuth client token endpoint rule", () => {
  it("allows the token endpoint the app definition fixes", () => {
    expect(instanceClientTokenUrlAllowed(slack(), "slack", "https://slack.com/api/oauth.v2.access")).toBe(true);
  });

  it.each([
    ["a different host", "https://attacker.example/token"],
    ["a lookalike path on the vendor host", "https://slack.com/api/oauth.v2.access/../../collect"],
    ["plain http on the vendor host", "http://slack.com/api/oauth.v2.access"],
    ["a vendor subdomain", "https://evil.slack.com/api/oauth.v2.access"],
    ["credentials in the URL", "https://user:pass@slack.com/api/oauth.v2.access"],
    ["no token endpoint", null],
  ])("refuses %s", (_label, tokenUrl) => {
    expect(instanceClientTokenUrlAllowed(slack({ tokenUrl }), "slack", tokenUrl)).toBe(false);
  });

  it("refuses a custom connection that names a gallery provider", () => {
    expect(instanceClientTokenUrlAllowed(
      generic({ provider: "slack", tokenUrl: "https://attacker.example/token" }),
      "slack",
      "https://attacker.example/token",
    )).toBe(false);
    expect(instanceClientTokenUrlAllowed(
      generic({ provider: "slack" }),
      "slack",
      "https://slack.com/api/oauth.v2.access",
    )).toBe(false);
  });

  it("refuses a custom server, even at its own host", () => {
    expect(instanceClientTokenUrlAllowed(generic(), "mcp_example_test", "https://mcp.example.test/oauth/token")).toBe(false);
    const lookalike = connection({ url: "https://mcp-example.test/mcp", oauth: {} });
    expect(instanceClientTokenUrlAllowed(lookalike, "mcp_example_test", "https://mcp-example.test/oauth/token")).toBe(false);
  });

  it.each(["", " ", " slack"])("never treats the gallery marker %j as an app definition", (marker) => {
    const marked = connection({ sourceTemplateKey: marker, url: "https://attacker.example/mcp", oauth: {} });
    for (const provider of [marker, "slack", "attacker_example"]) {
      expect(instanceClientTokenUrlAllowed(marked, provider, "https://attacker.example/token")).toBe(false);
    }
    expect(instanceClientTokenUrlAllowed(marked, "slack", "https://slack.com/api/oauth.v2.access")).toBe(false);
  });

  it("refuses a connection that claims another app's provider", () => {
    expect(instanceClientTokenUrlAllowed(slack({ provider: "gmail" }), "gmail", "https://oauth2.googleapis.com/token")).toBe(false);
  });

  it("allows a discovered token endpoint only on a fixed host when the definition pins none", () => {
    const notion = connection({ sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" });
    expect(instanceClientTokenUrlAllowed(notion, "notion", "https://mcp.notion.com/token")).toBe(true);
    for (const tokenUrl of [
      "https://api.notion.com/v1/oauth/token",
      "https://evil.notion.com/token",
      "https://mcp.notion.com:8443/token",
      "https://attacker.example/token",
    ]) {
      expect(instanceClientTokenUrlAllowed(notion, "notion", tokenUrl)).toBe(false);
    }
  });

  it.each([
    ["asana", "mcp-own-oauth", "https://app.asana.com/-/oauth_token"],
    ["railway", "mcp-oauth", "https://backboard.railway.com/oauth/token"],
  ])("allows the token endpoint that the %s definition pins", (slug, methodKey, tokenUrl) => {
    const pinned = connection({ sourceTemplateKey: slug, connectionMethodKey: methodKey });
    expect(instanceClientTokenUrlAllowed(pinned, slug, tokenUrl)).toBe(true);
    expect(instanceClientTokenUrlAllowed(pinned, slug, "https://attacker.example/token")).toBe(false);
  });

  it("makes every customer OAuth method pin its token endpoint or name its same-host fallback", () => {
    const sameHostFallback = new Set([
      "box:mcp-own-oauth",
      "notion:mcp-oauth",
      "posthog:mcp-oauth",
      "sentry:mcp-oauth",
      "vercel:mcp-oauth",
      "xero:mcp-own-oauth",
    ]);
    const noFixedEndpoint = new Set(["oauth-generic:oauth"]);
    const unpinned = APP_DEFINITIONS.flatMap((app) => app.methods
      .filter((method) => method.auth === "oauth" && !method.oauthStrategy && method.ownershipModes.includes("customer")
        && method.purpose !== "ai" && method.transport !== "runtime_auth" && !method.defaults?.tokenEndpoint)
      .map((method) => `${app.slug}:${method.key}`));
    expect(unpinned.sort()).toEqual([...sameHostFallback, ...noFixedEndpoint].sort());
  });
});
