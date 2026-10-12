import { beforeEach, describe, expect, it, vi } from "vitest";

// GRE-254: the Conference Room relay picks the company's Claude account, never
// the host's login.

const mockAiConnections = vi.hoisted(() => ({
  list: vi.fn(),
  select: vi.fn(),
  credential: vi.fn(),
}));

vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => mockAiConnections,
}));

vi.mock("../services/ai-connection-runtime.js", () => ({
  AI_AUTH_ENV_KEYS: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
}));

const { boardChatClaudeEnv, resolveBoardChatClaudeCredential } = await import(
  "../services/board-chat-claude-credential.js"
);

const account = (over: Record<string, unknown>) => ({
  id: "conn-1",
  grantId: "grant-1",
  provider: "anthropic",
  method: "subscription",
  ownership: "personal",
  isDefault: false,
  status: "connected",
  ...over,
});

describe("resolveBoardChatClaudeCredential (GRE-254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiConnections.credential.mockResolvedValue("secret-value");
    mockAiConnections.select.mockImplementation(async (input: any) => ({
      attribution: { method: input.binding.method },
    }));
  });

  it("uses the user's personal Claude default before a shared account", async () => {
    mockAiConnections.list.mockResolvedValue([
      account({ id: "shared-1", grantId: "g-shared", ownership: "shared", method: "api_key" }),
      account({ id: "mine", grantId: "g-mine", isDefault: true }),
    ]);

    const result = await resolveBoardChatClaudeCredential({} as any, { companyId: "c1", userId: "u1" });

    expect(mockAiConnections.select.mock.calls[0][0]).toMatchObject({
      companyId: "c1",
      userId: "u1",
      adapterType: "claude_local",
      binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
    });
    expect(result).toEqual({ envKey: "CLAUDE_CODE_OAUTH_TOKEN", value: "secret-value" });
  });

  it("falls back to a connected company-shared Claude account", async () => {
    mockAiConnections.list.mockResolvedValue([
      account({ provider: "openai", isDefault: true }),
      account({ id: "shared-1", grantId: "g-shared", ownership: "shared", method: "api_key" }),
    ]);

    const result = await resolveBoardChatClaudeCredential({} as any, { companyId: "c1", userId: "u1" });

    expect(mockAiConnections.select.mock.calls[0][0].binding).toEqual({
      provider: "anthropic",
      method: "api_key",
      mode: "shared",
      connectionId: "shared-1",
      grantId: "g-shared",
    });
    expect(result).toEqual({ envKey: "ANTHROPIC_API_KEY", value: "secret-value" });
  });

  it("returns null when the company has no Claude account for the user", async () => {
    mockAiConnections.list.mockResolvedValue([account({ provider: "openai", isDefault: true })]);

    const result = await resolveBoardChatClaudeCredential({} as any, { companyId: "c1", userId: "u1" });

    expect(result).toBeNull();
    expect(mockAiConnections.select).not.toHaveBeenCalled();
    expect(mockAiConnections.credential).not.toHaveBeenCalled();
  });
});

describe("boardChatClaudeEnv (GRE-254)", () => {
  it("drops inherited AI credentials and sets only the company credential", () => {
    const env = boardChatClaudeEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "host-key", CLAUDE_CODE_OAUTH_TOKEN: "host-token", CLAUDE_CONFIG_DIR: "/host" },
      { envKey: "CLAUDE_CODE_OAUTH_TOKEN", value: "company-token" },
      "/tmp/fresh",
      { GSAM_COMPANY_ID: "c1" },
    );

    expect(env).toEqual({
      PATH: "/bin",
      GSAM_COMPANY_ID: "c1",
      CLAUDE_CONFIG_DIR: "/tmp/fresh",
      CLAUDE_CODE_OAUTH_TOKEN: "company-token",
    });
  });
});
