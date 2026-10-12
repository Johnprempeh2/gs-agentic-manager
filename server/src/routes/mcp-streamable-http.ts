import type { Response } from "express";

/**
 * Streamable HTTP transport rules shared by GS Agentic Manager's own MCP
 * server endpoints: the named tool gateways, the runtime tools endpoint and
 * the project tools endpoint. Each answers one JSON body per POST and offers
 * no SSE stream.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * - a notification or response POSTed by the client gets 202 with no body;
 * - a request gets a JSON-RPC response, errors included, so an unknown method
 *   is a -32601 error in an HTTP 200 body, never an HTTP 404 (clients read a
 *   404 as "session gone" and restart the handshake);
 * - a GET on an endpoint without an SSE stream gets 405 Method Not Allowed.
 */

export type McpInboundMessage =
  | { kind: "request"; id: string | number | null; method: string; params: unknown }
  | { kind: "notification"; method: string }
  | { kind: "response" }
  | { kind: "invalid" };

/** Classify one POSTed JSON-RPC message. Batches are not supported. */
export function classifyMcpMessage(body: unknown): McpInboundMessage {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "invalid" };
  const message = body as Record<string, unknown>;
  const id = message.id;
  if (typeof message.method === "string" && message.method.length > 0) {
    // A notification carries no id. The notifications/ namespace is never
    // answered, even from a client that attaches an id to it.
    if (id === undefined || message.method.startsWith("notifications/")) {
      return { kind: "notification", method: message.method };
    }
    if (id !== null && typeof id !== "string" && typeof id !== "number") return { kind: "invalid" };
    return { kind: "request", id, method: message.method, params: message.params };
  }
  if (id !== undefined && ("result" in message || "error" in message)) return { kind: "response" };
  return { kind: "invalid" };
}

/** Notifications and client responses need no answer: 202 Accepted, no body. */
export function acceptMcpMessage(res: Response) {
  res.status(202).end();
}

export function sendMcpInvalidRequest(res: Response) {
  res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
}

export function sendMcpMethodNotFound(res: Response, id: string | number | null) {
  res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

/** GET opens an optional SSE stream; these endpoints offer none, so 405. */
export function sendMcpGetNotAllowed(res: Response) {
  res.setHeader("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Method not allowed: this MCP endpoint offers no SSE stream; send JSON-RPC messages with POST" },
  });
}
