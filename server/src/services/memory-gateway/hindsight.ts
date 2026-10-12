import { createHmac, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryRetainMode } from "@greatstone/shared";
import { logger } from "../../middleware/logger.js";
import {
  MEMORY_ENGINE_RETAIN_TIMEOUT_MS,
  MEMORY_ENGINE_TIMEOUT_MS,
  MemoryEngineUnavailableError,
  unconfiguredMemoryEngine,
  type MemoryEngine,
  type MemoryEngineRetainResult,
} from "./engine.js";

/**
 * Hindsight adapter (ADR-0001, pinned v0.10.2). Every call carries the API key
 * and a signed, 60-second assertion naming the one bank and the tags the
 * gateway allowed. The Greatstone extension in the engine
 * (`scripts/gs-memory/extension/gsam_memory_extension.py`) refuses any call
 * without both, so the key alone or a known bank id reaches nothing.
 */

export const MEMORY_ASSERTION_HEADER = "x-gsam-memory-assertion";
export const MEMORY_ASSERTION_TTL_SECONDS = 60;

export type MemoryAssertionClaims = {
  v: 1;
  op: "retain" | "recall" | "delete" | "configure";
  bank: string;
  /** Recall: the engine forces a strict match on these tags. */
  read: string[];
  /** Retain: every tag on the document must be in this list. */
  write: string[];
  doc: string | null;
  iat: number;
  exp: number;
  nonce: string;
};

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

/** `base64url(json).base64url(hmac-sha256(secret, base64url(json)))` */
export function signMemoryAssertion(
  secret: string,
  claims: Omit<MemoryAssertionClaims, "v" | "iat" | "exp" | "nonce">,
  now = Date.now(),
) {
  const iat = Math.floor(now / 1000);
  const body: MemoryAssertionClaims = {
    v: 1,
    ...claims,
    iat,
    exp: iat + MEMORY_ASSERTION_TTL_SECONDS,
    nonce: randomUUID(),
  };
  const payload = base64url(JSON.stringify(body));
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

const HINDSIGHT_MODE: Record<MemoryRetainMode, string> = {
  extract: "concise",
  chunks: "chunks",
};

/** Hindsight's answer for a bank that has no documents yet: `404 {"detail": "Bank '…' not found"}`. */
const BANK_NOT_FOUND_RE = /Bank '[^']*' not found/;

type HindsightRecallResult = {
  id?: string | null;
  type?: string | null;
  document_id?: string | null;
  text?: string;
  scores?: Record<string, number> | null;
};

/**
 * Memory Defense for every gateway bank (GRE-868): the engine's regex screen
 * refuses an item that holds a secret or personal-data pattern. The gateway
 * refuses these first (sensitive-content.ts); this is the second layer.
 */
export const HINDSIGHT_MEMORY_DEFENSE = {
  enabled: true,
  rules: [{ on: "sensitive_data", action: "block" }],
} as const;

export function createHindsightMemoryEngine(options: {
  baseUrl: string;
  apiKey: string;
  assertionSecret: string;
  timeoutMs?: number;
  /** Retain with Claude extraction can take far longer than a recall. */
  retainTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): MemoryEngine {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MEMORY_ENGINE_TIMEOUT_MS;
  const retainTimeoutMs = options.retainTimeoutMs ?? MEMORY_ENGINE_RETAIN_TIMEOUT_MS;
  /** Bank → retain mode last set on the engine, so a mode switch reconfigures the bank once. */
  const bankModes = new Map<string, MemoryRetainMode>();

  async function call(
    method: string,
    route: string,
    claims: Omit<MemoryAssertionClaims, "v" | "iat" | "exp" | "nonce">,
    body?: unknown,
    callTimeoutMs = timeoutMs,
  ) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          [MEMORY_ASSERTION_HEADER]: signMemoryAssertion(options.assertionSecret, claims),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(callTimeoutMs),
      });
    } catch (error) {
      throw new MemoryEngineUnavailableError("Memory engine is not reachable", { cause: error });
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 1000);
      // 5xx, 429 and auth failures all mean "memory unavailable" to callers;
      // the message stays in logs and sync_error for whoever fixes it. The raw
      // status and detail are kept so the outbox can tell a plan limit or a
      // rejected entry from an outage.
      throw new MemoryEngineUnavailableError(`Memory engine answered ${response.status} on ${method} ${route}: ${text}`, {
        status: response.status,
      });
    }
    return response.status === 204 ? null : response.json().catch(() => null);
  }

  const bankPath = (bankId: string) => `/v1/default/banks/${encodeURIComponent(bankId)}`;

  async function ensureMode(bankId: string, mode: MemoryRetainMode) {
    if (bankModes.get(bankId) === mode) return;
    await call("PUT", bankPath(bankId), { op: "configure", bank: bankId, read: [], write: [], doc: null }, {
      retain_extraction_mode: HINDSIGHT_MODE[mode],
      enable_observations: false,
    });
    // The bank PUT drops `memory_defense`; only the config route stores it.
    await call("PATCH", `${bankPath(bankId)}/config`, { op: "configure", bank: bankId, read: [], write: [], doc: null }, {
      updates: { memory_defense: HINDSIGHT_MEMORY_DEFENSE },
    });
    bankModes.set(bankId, mode);
  }

  return {
    async retain(document): Promise<MemoryEngineRetainResult> {
      await ensureMode(document.bankId, document.mode);
      const result = (await call(
        "POST",
        `${bankPath(document.bankId)}/memories`,
        { op: "retain", bank: document.bankId, read: [], write: document.tags, doc: document.documentId },
        {
          async: false,
          items: [
            {
              content: document.content,
              context: document.context ?? undefined,
              timestamp: document.timestamp,
              document_id: document.documentId,
              tags: document.tags,
              metadata: document.metadata,
              entities: document.entities.map((text) => ({ text })),
              // Entities come from the contributor; no fuzzy merge with others.
              resolve_entities: false,
            },
          ],
        },
        retainTimeoutMs,
      )) as { usage?: { input_tokens?: number; output_tokens?: number } | null } | null;
      const usage = result?.usage;
      return usage
        ? { usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 } }
        : { usage: null };
    },

    async recall(request) {
      if (request.tags.length === 0) return [];
      let result: { results?: HindsightRecallResult[] } | null;
      try {
        result = (await call(
          "POST",
          `${bankPath(request.bankId)}/memories/recall`,
          { op: "recall", bank: request.bankId, read: request.tags, write: [], doc: null },
          { query: request.query, tags: request.tags, tags_match: "any_strict", budget: "mid", max_tokens: 4096 },
        )) as { results?: HindsightRecallResult[] } | null;
      } catch (error) {
        // A bank is made on its first retain (GRE-867). Until then it holds
        // nothing, so it must not make the whole recall "unavailable".
        if (error instanceof MemoryEngineUnavailableError && error.status === 404 && BANK_NOT_FOUND_RE.test(error.message)) {
          return [];
        }
        throw error;
      }
      return (result?.results ?? [])
        .filter((hit): hit is HindsightRecallResult & { document_id: string } => typeof hit.document_id === "string")
        .slice(0, request.limit * 3)
        .map((hit) => {
          const scores = hit.scores ? Object.values(hit.scores).filter((value) => typeof value === "number") : [];
          return {
            documentId: hit.document_id,
            text: hit.text ?? "",
            score: scores.length ? Math.max(...scores) : null,
            unitId: typeof hit.id === "string" ? hit.id : null,
            factType: typeof hit.type === "string" ? hit.type : null,
          };
        });
    },

    async deleteDocument(bankId, documentId) {
      await call(
        "DELETE",
        `${bankPath(bankId)}/documents/${encodeURIComponent(documentId)}`,
        { op: "delete", bank: bankId, read: [], write: [], doc: documentId },
      );
    },
  };
}

export const MEMORY_GATEWAY_CONFIG_KEYS = [
  "GSAM_MEMORY_ENGINE_URL",
  "GSAM_MEMORY_ENGINE_API_KEY",
  "GSAM_MEMORY_ASSERTION_SECRET",
] as const;

export function defaultMemoryGatewayConfigPath(env: NodeJS.ProcessEnv = process.env) {
  return env.GSAM_MEMORY_GATEWAY_CONFIG?.trim() || path.join(os.homedir(), "gs-memory", "secrets", "gateway.env");
}

/** Reads `KEY=value` lines. Returns null when the file is missing, open to others, or incomplete. */
export async function readMemoryGatewayConfig(filePath: string) {
  let text: string;
  try {
    const info = await stat(filePath);
    // Owner-only, like the engine's own secrets: a group- or world-readable
    // file is treated as not configured.
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      logger.warn({ filePath }, "memory gateway config is readable by others; memory stays unavailable until it is chmod 600");
      return null;
    }
    text = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  const [baseUrl, apiKey, assertionSecret] = MEMORY_GATEWAY_CONFIG_KEYS.map((key) => values.get(key) ?? "");
  if (!baseUrl || !apiKey || !assertionSecret) return null;
  return { baseUrl, apiKey, assertionSecret };
}

/**
 * The engine the gateway talks to. Secrets are read from an owner-only file,
 * never from the server environment: agent processes inherit that environment.
 * The file is read on first use and again while it is missing, so nothing
 * needs the engine at boot.
 */
export function memoryEngineFromGatewayConfig(filePath = defaultMemoryGatewayConfigPath()): MemoryEngine {
  let engine: MemoryEngine | null = null;
  const resolve = async () => {
    if (engine) return engine;
    const config = await readMemoryGatewayConfig(filePath);
    if (!config) return unconfiguredMemoryEngine();
    engine = createHindsightMemoryEngine(config);
    return engine;
  };
  return {
    retain: async (document) => (await resolve()).retain(document),
    recall: async (request) => (await resolve()).recall(request),
    deleteDocument: async (bankId, documentId) => (await resolve()).deleteDocument(bankId, documentId),
  };
}
