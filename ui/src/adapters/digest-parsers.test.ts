import { describe, expect, it } from "vitest";
import { parseClaudeStdoutLine } from "@greatstone/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@greatstone/adapter-codex-local/ui";
import { parseCursorCloudStdoutLine } from "@greatstone/adapter-cursor-cloud/ui";
import { parseCursorStdoutLine } from "@greatstone/adapter-cursor-local/ui";
import { parseGeminiStdoutLine } from "@greatstone/adapter-gemini-local/ui";
import { createGrokStdoutParser, parseGrokStdoutLine } from "@greatstone/adapter-grok-local/ui";
import { parseKimiStdoutLine } from "@greatstone/adapter-kimi-local/ui";
import { parseOpenClawGatewayStdoutLine } from "@greatstone/adapter-openclaw-gateway/ui";
import { parseOpenCodeStdoutLine } from "@greatstone/adapter-opencode-local/ui";
import { parsePiStdoutLine } from "@greatstone/adapter-pi-local/ui";
import { getUIAdapter } from "./registry";

// The server digests finished runs with these parsers
// (server/src/services/run-transcript-digests.ts, DIGEST_PARSERS). A digest is
// only identical to the board's own transcript while the board uses the same
// parser for the type, so a change here must change the server map too.
const DIGEST_PARSERS = {
  claude_local: { parseStdoutLine: parseClaudeStdoutLine },
  codex_local: { parseStdoutLine: parseCodexStdoutLine },
  cursor_cloud: { parseStdoutLine: parseCursorCloudStdoutLine },
  cursor: { parseStdoutLine: parseCursorStdoutLine },
  gemini_local: { parseStdoutLine: parseGeminiStdoutLine },
  grok_local: { parseStdoutLine: parseGrokStdoutLine, createStdoutParser: createGrokStdoutParser },
  kimi_local: { parseStdoutLine: parseKimiStdoutLine },
  openclaw_gateway: { parseStdoutLine: parseOpenClawGatewayStdoutLine },
  opencode_local: { parseStdoutLine: parseOpenCodeStdoutLine },
  pi_local: { parseStdoutLine: parsePiStdoutLine },
};

describe("run digest parsers", () => {
  it.each(Object.entries(DIGEST_PARSERS))("%s uses the parser the server digests with", (type, parser) => {
    const adapter = getUIAdapter(type);
    expect(adapter.parseStdoutLine).toBe(parser.parseStdoutLine);
    expect(adapter.createStdoutParser).toBe("createStdoutParser" in parser ? parser.createStdoutParser : undefined);
  });
});
