import type { MemoryConnectionApp } from "@greatstone/shared";

export interface MemoryConnectionSetup {
  /** Plain steps, in order. */
  steps: string[];
  /** What to paste, with the key filled in. Null when the app cannot connect yet. */
  snippet: string | null;
}

/** The memory MCP endpoint on this GSAM instance. */
export function memoryMcpUrl(origin: string) {
  return `${origin.replace(/\/+$/, "")}/api/mcp/memory-tools`;
}

/** Apps that connect by signing in to GSAM rather than with a pasted key. */
export const MEMORY_SIGN_IN_APPS = ["chatgpt", "claude_ai"] as const;
export type MemorySignInApp = (typeof MEMORY_SIGN_IN_APPS)[number];

export function isMemorySignInApp(app: MemoryConnectionApp): app is MemorySignInApp {
  return (MEMORY_SIGN_IN_APPS as readonly string[]).includes(app);
}

/** How to add GSAM memory in ChatGPT or Claude.ai, which sign in instead of taking a key. */
export function memoryAppSignInSteps(app: MemorySignInApp, url: string): string[] {
  if (app === "chatgpt") {
    return [
      "In ChatGPT, open Settings, then Apps and connectors. If there is no Create button, turn on Developer mode under Advanced first.",
      `Choose Create, name it GSAM memory and paste this address: ${url}`,
      "Choose OAuth for sign-in and save. ChatGPT opens GSAM: sign in if asked, then press Allow.",
      "In a chat or in voice mode, ask ChatGPT to search GSAM memory.",
    ];
  }
  return [
    "On claude.ai, open Settings, then Connectors, and choose Add custom connector.",
    `Name it GSAM memory, paste this address and choose Add: ${url}`,
    "Choose Connect. Claude opens GSAM: sign in if asked, then press Allow.",
    "It then works in every Claude.ai chat, including the phone app and projects.",
  ];
}

/** Setup for each app. The key goes in a header, never in the URL. */
export function memoryConnectionSetup(app: MemoryConnectionApp, url: string, token: string): MemoryConnectionSetup {
  switch (app) {
    case "claude":
      return {
        steps: [
          "This needs Node.js on the computer. If you are not sure, ask whoever set up your Mac to check.",
          "In the Claude desktop app, open Settings, then Developer, then Edit Config.",
          "Paste the text below into the file that opens, save it, then quit and reopen Claude.",
          "In a new chat, ask Claude to search GSAM memory. It will ask you to allow it the first time.",
        ],
        snippet: JSON.stringify(
          {
            mcpServers: {
              "gsam-memory": {
                command: "npx",
                args: ["-y", "mcp-remote", url, "--header", "Authorization:${GSAM_MEMORY_AUTH}"],
                env: { GSAM_MEMORY_AUTH: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        ),
      };
    case "claude_code":
      return {
        steps: ["Run this once in a terminal.", "Start Claude Code and ask it to search GSAM memory."],
        snippet: `claude mcp add --transport http gsam-memory ${url} --header "Authorization: Bearer ${token}"`,
      };
    case "codex":
      return {
        steps: [
          "Add these lines to ~/.codex/config.toml.",
          "Put the export line in your shell profile so Codex can read the key, then start Codex.",
        ],
        snippet: `[mcp_servers.gsam_memory]\nurl = "${url}"\nbearer_token_env_var = "GSAM_MEMORY_TOKEN"\n\n# in ~/.zshrc\nexport GSAM_MEMORY_TOKEN="${token}"`,
      };
    case "chatgpt":
    case "claude_ai":
      return { steps: memoryAppSignInSteps(app, url), snippet: null };
    case "other":
      return {
        steps: ["Give the app this address and header. It must support MCP over HTTP."],
        snippet: `URL: ${url}\nHeader: Authorization: Bearer ${token}`,
      };
  }
}
