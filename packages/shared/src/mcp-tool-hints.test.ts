import { describe, expect, it } from "vitest";
import { hasMcpToolHints, mcpToolHints } from "./mcp-tool-hints.js";

describe("mcpToolHints", () => {
  it("maps each effect to MCP annotations", () => {
    expect(mcpToolHints("read")).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(mcpToolHints("write")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(mcpToolHints("destructive", { idempotent: true })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("requires a read hint, and a destructive hint on writes", () => {
    expect(hasMcpToolHints(undefined)).toBe(false);
    expect(hasMcpToolHints({})).toBe(false);
    expect(hasMcpToolHints({ readOnlyHint: false })).toBe(false);
    expect(hasMcpToolHints({ readOnlyHint: true })).toBe(true);
    expect(hasMcpToolHints(mcpToolHints("write"))).toBe(true);
  });
});
