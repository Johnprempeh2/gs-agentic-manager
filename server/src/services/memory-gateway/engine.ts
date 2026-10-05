import type { MemoryRetainMode } from "@greatstone/shared";

/**
 * The memory engine behind the gateway (ADR-0001). Hindsight is the planned
 * engine; this interface keeps it swappable and lets tests use a double.
 * Callers pass only what the gateway already authorised: one bank and the
 * scope tags the caller may read or write.
 */
export interface MemoryEngineDocument {
  bankId: string;
  /** Always a `memory_records.id`. */
  documentId: string;
  content: string;
  context: string | null;
  /** Scope tag plus status, sensitivity and contributor tags. */
  tags: string[];
  entities: string[];
  metadata: Record<string, string>;
  timestamp: string | null;
  mode: MemoryRetainMode;
}

export interface MemoryEngineRecallRequest {
  bankId: string;
  query: string;
  /** Strict match: only documents carrying at least one of these tags. Never empty. */
  tags: string[];
  limit: number;
}

export interface MemoryEngineHit {
  documentId: string;
  text: string;
  score: number | null;
  /** The engine's id for the extracted fact (Hindsight memory unit), when it sends one. */
  unitId?: string | null;
  /** The engine's fact type (for Hindsight: `world` or `experience`). */
  factType?: string | null;
}

/** Model tokens the engine reported for one retain (Claude plan use). */
export interface MemoryEngineUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MemoryEngineRetainResult {
  usage?: MemoryEngineUsage | null;
}

export interface MemoryEngine {
  /** Idempotent: `documentId` is the record id, so a replay replaces the same document. */
  retain(document: MemoryEngineDocument): Promise<MemoryEngineRetainResult | void>;
  recall(request: MemoryEngineRecallRequest): Promise<MemoryEngineHit[]>;
  deleteDocument(bankId: string, documentId: string): Promise<void>;
}

/** The engine is not configured, not reachable, timed out or answered with a server error. */
export class MemoryEngineUnavailableError extends Error {
  /** HTTP status the engine answered with, when it answered at all. */
  readonly status?: number;

  constructor(message = "Memory engine unavailable", options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "MemoryEngineUnavailableError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** Used until an engine is configured: every call reports "memory unavailable". */
export function unconfiguredMemoryEngine(): MemoryEngine {
  const fail = async (): Promise<never> => {
    throw new MemoryEngineUnavailableError("Memory engine is not configured");
  };
  return { retain: fail, recall: fail, deleteDocument: fail };
}

export const MEMORY_ENGINE_TIMEOUT_MS = 8_000;
/** Upper bound for one retain at the adapter; the request path still caps it with `withEngineTimeout`. */
export const MEMORY_ENGINE_RETAIN_TIMEOUT_MS = 120_000;

/** Bounds every engine call so a stuck engine never hangs an agent run. */
export async function withEngineTimeout<T>(work: Promise<T>, timeoutMs = MEMORY_ENGINE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MemoryEngineUnavailableError(`Memory engine did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error instanceof MemoryEngineUnavailableError) throw error;
    throw new MemoryEngineUnavailableError("Memory engine call failed", { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
