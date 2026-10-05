/**
 * MCP effect hints for tools on GS Agentic Manager's own MCP servers.
 * Governance reads these to set a tool's risk (read, write, destructive), so
 * every tool we serve must declare them instead of leaving risk to be guessed
 * from its name. `destructive` means the tool can delete or irreversibly
 * change data; overwriting a field is `write`.
 */
export type McpToolEffect = "read" | "write" | "destructive";

export interface McpToolHints {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/** Our tools act only on GS Agentic Manager data, so they are never open-world. */
export function mcpToolHints(
  effect: McpToolEffect,
  options: { idempotent?: boolean } = {},
): McpToolHints {
  if (effect === "read") return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: effect === "destructive",
    ...(options.idempotent === undefined ? {} : { idempotentHint: options.idempotent }),
    openWorldHint: false,
  };
}

/** True when a tool declares the hints governance needs to classify it. */
export function hasMcpToolHints(annotations: unknown): boolean {
  if (!annotations || typeof annotations !== "object") return false;
  const hints = annotations as Record<string, unknown>;
  if (typeof hints.readOnlyHint !== "boolean") return false;
  return hints.readOnlyHint || typeof hints.destructiveHint === "boolean";
}
