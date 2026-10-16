import { describe, expect, it } from "vitest";
import {
  deriveAgentAccess,
  expiresInLabel,
  type AgentAccessConnectionInput,
  type AgentAccessGrantInput,
  type AgentAccessInput,
} from "../services/agent-access.js";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

function connection(overrides: Partial<AgentAccessConnectionInput> & { id: string }): AgentAccessConnectionInput {
  return {
    name: overrides.id,
    healthStatus: "ok",
    credentialPolicy: "shared",
    credentialSecretRefs: [],
    ...overrides,
  };
}

function grant(overrides: Partial<AgentAccessGrantInput> & { id: string; connectionId: string }): AgentAccessGrantInput {
  return {
    kind: "organization",
    subjectAgentId: null,
    status: "active",
    ...overrides,
  };
}

function input(overrides: Partial<AgentAccessInput>): AgentAccessInput {
  return {
    now: NOW,
    agents: [{ id: "agent-1", name: "Writer" }],
    connections: [],
    installs: [],
    grants: [],
    delegations: [],
    mcpTokens: [],
    secretBindings: [],
    channels: [],
    ...overrides,
  };
}

function itemsFor(summary: ReturnType<typeof deriveAgentAccess>, agentId = "agent-1") {
  return summary.agents.find((agent) => agent.agentId === agentId)!.items;
}

describe("deriveAgentAccess", () => {
  it("marks a healthy shared app as ok and an untested one as unchecked", () => {
    const summary = deriveAgentAccess(input({
      connections: [
        connection({ id: "healthy", name: "Notion" }),
        connection({ id: "untested", name: "Linear", healthStatus: "unchecked" }),
      ],
      installs: [
        { connectionId: "healthy", targetType: "company", targetId: "company-1" },
        { connectionId: "untested", targetType: "agent", targetId: "agent-1" },
      ],
    }));
    const items = itemsFor(summary);
    expect(items.map((item) => [item.label, item.state, item.reason])).toEqual([
      ["Linear", "unchecked", "Not checked yet"],
      ["Notion", "ok", null],
    ]);
    expect(summary.agents[0]!.counts).toEqual({ missing: 0, failing: 0, expiring: 0 });
    expect(summary.generatedAt).toBe(NOW.toISOString());
  });

  it("only lists apps installed for the agent or the whole company", () => {
    const summary = deriveAgentAccess(input({
      agents: [{ id: "agent-1", name: "Writer" }, { id: "agent-2", name: "Reviewer" }],
      connections: [connection({ id: "mine" })],
      installs: [{ connectionId: "mine", targetType: "agent", targetId: "agent-2" }],
    }));
    expect(itemsFor(summary, "agent-1")).toEqual([]);
    expect(itemsFor(summary, "agent-2")).toHaveLength(1);
  });

  it("flags attention health and grants that need reconnecting as failing", () => {
    const summary = deriveAgentAccess(input({
      connections: [
        connection({ id: "broken", healthStatus: "missing_secret" }),
        connection({ id: "reauth" }),
      ],
      installs: [
        { connectionId: "broken", targetType: "company", targetId: "c" },
        { connectionId: "reauth", targetType: "company", targetId: "c" },
      ],
      grants: [grant({ id: "g1", connectionId: "reauth", status: "needs_reauthorization", isDefault: true })],
    }));
    const byId = new Map(itemsFor(summary).map((item) => [item.id, item]));
    expect(byId.get("broken")).toMatchObject({ state: "failing", reason: "The key it needs is missing" });
    expect(byId.get("reauth")).toMatchObject({ state: "failing", reason: "Needs to be reconnected" });
    expect(summary.agents[0]!.counts.failing).toBe(2);
  });

  it("treats a per-agent app with no grant for this agent as missing", () => {
    const summary = deriveAgentAccess(input({
      agents: [{ id: "agent-1", name: "Writer" }, { id: "agent-2", name: "Reviewer" }],
      connections: [connection({ id: "gh", credentialPolicy: "per_agent" })],
      installs: [{ connectionId: "gh", targetType: "company", targetId: "c" }],
      grants: [grant({ id: "g2", connectionId: "gh", kind: "agent", subjectAgentId: "agent-2" })],
    }));
    expect(itemsFor(summary, "agent-1")[0]).toMatchObject({ state: "missing", reason: "No sign-in set up for this agent" });
    expect(itemsFor(summary, "agent-2")[0]).toMatchObject({ state: "ok" });
  });

  it("does not call a personal-only app missing, since the responsible person signs in", () => {
    const base = {
      connections: [connection({ id: "drive", credentialPolicy: "per_user" as const })],
      installs: [{ connectionId: "drive", targetType: "company", targetId: "c" }],
    };
    expect(itemsFor(deriveAgentAccess(input(base)))[0]).toMatchObject({
      state: "unchecked",
      reason: "Uses the sign-in of the person responsible for the work",
    });
    const delegated = deriveAgentAccess(input({
      ...base,
      grants: [grant({ id: "user-grant", connectionId: "drive", kind: "user" })],
      delegations: [{ grantId: "user-grant", agentId: "agent-1" }],
    }));
    expect(itemsFor(delegated)[0]!.state).toBe("ok");
  });

  it("flags sign-ins, keys and gateway tokens that expire within 14 days", () => {
    const summary = deriveAgentAccess(input({
      connections: [
        connection({ id: "oauth" }),
        connection({ id: "key", credentialSecretRefs: [{ expiresAt: inDays(3) }] }),
        connection({ id: "later", credentialSecretRefs: [{ expiresAt: inDays(40) }] }),
      ],
      installs: ["oauth", "key", "later"].map((id) => ({ connectionId: id, targetType: "company", targetId: "c" })),
      grants: [grant({ id: "g", connectionId: "oauth", refreshTokenExpiresAt: inDays(5) })],
      mcpTokens: [
        { id: "t1", name: "Gateway key", subjectId: "agent-1", expiresAt: inDays(-1) },
        { id: "t2", name: "Other agent", subjectId: "agent-2", expiresAt: inDays(1) },
      ],
    }));
    const byId = new Map(itemsFor(summary).map((item) => [item.id, item]));
    expect(byId.get("oauth")).toMatchObject({ state: "expiring", reason: "Expires in 5 days", expiresAt: inDays(5) });
    expect(byId.get("key")).toMatchObject({ state: "expiring", reason: "Expires in 3 days" });
    expect(byId.get("later")).toMatchObject({ state: "ok" });
    expect(byId.get("t1")).toMatchObject({ kind: "mcp_token", state: "failing", reason: "This key has expired" });
    expect(byId.has("t2")).toBe(false);
    expect(summary.agents[0]!.counts).toEqual({ missing: 0, failing: 1, expiring: 2 });
  });

  it("flags a required secret that was deleted and an unhealthy GitHub webhook", () => {
    const summary = deriveAgentAccess(input({
      connections: [connection({ id: "github" })],
      installs: [{ connectionId: "github", targetType: "company", targetId: "c" }],
      grants: [grant({ id: "g", connectionId: "github", webhookHealth: "unhealthy" })],
      secretBindings: [
        {
          id: "binding-1",
          agentId: "agent-1",
          configPath: "env.API_KEY",
          label: null,
          required: true,
          secretName: "API key",
          secretStatus: "active",
          secretDeletedAt: inDays(-2),
        },
        {
          id: "binding-2",
          agentId: "agent-1",
          configPath: "env.OPTIONAL",
          label: "Optional key",
          required: false,
          secretName: "Optional",
          secretStatus: "disabled",
        },
      ],
    }));
    const byId = new Map(itemsFor(summary).map((item) => [item.id, item]));
    expect(byId.get("binding-1")).toMatchObject({ kind: "secret", label: "API key", state: "missing", reason: "The secret it needs has been deleted" });
    expect(byId.get("binding-2")).toMatchObject({ state: "ok" });
    expect(byId.get("github")).toMatchObject({ state: "failing" });
  });

  it("maps channel status and orders attention items first", () => {
    const summary = deriveAgentAccess(input({
      channels: [
        { id: "c1", connectionId: "conn", provider: "slack", assignedAgentId: "agent-1", status: "active", label: "Acme" },
        { id: "c2", connectionId: "conn", provider: "telegram", assignedAgentId: "agent-1", status: "attention", label: null },
        { id: "c3", connectionId: "conn", provider: "discord", assignedAgentId: "agent-1", status: "revoked", label: null },
      ],
    }));
    expect(itemsFor(summary).map((item) => [item.label, item.state])).toEqual([
      ["Discord", "failing"],
      ["Telegram", "failing"],
      ["Slack: Acme", "ok"],
    ]);
  });

  it("never emits credential material", () => {
    const summary = deriveAgentAccess(input({
      connections: [connection({ id: "c", credentialSecretRefs: [{ expiresAt: inDays(2) }] })],
      installs: [{ connectionId: "c", targetType: "company", targetId: "x" }],
    }));
    const keys = new Set(itemsFor(summary).flatMap((item) => Object.keys(item)));
    expect([...keys].sort()).toEqual(["connectionId", "expiresAt", "id", "kind", "label", "lastUsedAt", "reason", "state"]);
  });

  it("words expiry in plain language", () => {
    expect(expiresInLabel(NOW.getTime() + 2 * 60 * 60 * 1000, NOW.getTime())).toBe("Expires within a day");
    expect(expiresInLabel(NOW.getTime() + 2 * DAY, NOW.getTime())).toBe("Expires in 2 days");
  });
});
