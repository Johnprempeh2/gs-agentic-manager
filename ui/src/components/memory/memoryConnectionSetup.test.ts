import { describe, expect, it } from "vitest";
import { isMemorySignInApp, memoryConnectionSetup, memoryMcpUrl } from "./memoryConnectionSetup";

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

  it("gives the Claude desktop app a valid config", () => {
    const claude = JSON.parse(memoryConnectionSetup("claude", url, "tok").snippet!);
    expect(claude.mcpServers["gsam-memory"].env.GSAM_MEMORY_AUTH).toBe("Bearer tok");
  });

  it("connects ChatGPT and Claude.ai by sign-in, never with a pasted key", () => {
    for (const app of ["chatgpt", "claude_ai"] as const) {
      expect(isMemorySignInApp(app)).toBe(true);
      const setup = memoryConnectionSetup(app, url, "tok");
      expect(setup.snippet).toBeNull();
      expect(setup.steps.join(" ")).toContain(url);
      expect(setup.steps.join(" ")).not.toContain("tok");
    }
    expect(isMemorySignInApp("codex")).toBe(false);
  });
});
