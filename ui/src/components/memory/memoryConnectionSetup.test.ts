import { describe, expect, it } from "vitest";
import { memoryConnectionSetup, memoryMcpUrl } from "./memoryConnectionSetup";

describe("memoryConnectionSetup", () => {
  const url = memoryMcpUrl("https://gsam.example/");

  it("builds the endpoint and keeps the key out of the URL", () => {
    expect(url).toBe("https://gsam.example/api/mcp/memory-tools");
    for (const app of ["claude", "claude_code", "codex", "other"] as const) {
      const setup = memoryConnectionSetup(app, url, "tok_123");
      expect(setup.snippet).toContain("tok_123");
      expect(setup.snippet).toContain(url);
      expect(setup.snippet).not.toContain(`${url}?`);
    }
  });

  it("gives the Claude desktop app a valid config and says ChatGPT cannot connect yet", () => {
    const claude = JSON.parse(memoryConnectionSetup("claude", url, "tok").snippet!);
    expect(claude.mcpServers["gsam-memory"].env.GSAM_MEMORY_AUTH).toBe("Bearer tok");
    expect(memoryConnectionSetup("chatgpt", url, "tok").snippet).toBeNull();
  });
});
