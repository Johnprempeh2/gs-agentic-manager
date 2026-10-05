import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MemoryEngineUnavailableError } from "./engine.js";
import { classifyEngineError } from "./ingest-outbox.js";
import {
  MEMORY_ASSERTION_HEADER,
  createHindsightMemoryEngine,
  memoryEngineFromGatewayConfig,
  readMemoryGatewayConfig,
  signMemoryAssertion,
} from "./hindsight.js";

const SECRET = "test-assertion-secret";
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/gs-memory/extension");

function decodeClaims(header: string) {
  return JSON.parse(Buffer.from(header.split(".")[0], "base64url").toString("utf8"));
}

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; claims: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    calls.push({ url: String(url), init: init!, claims: decodeClaims(headers[MEMORY_ASSERTION_HEADER]) });
    return respond(String(url), init!);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Hindsight memory engine adapter", () => {
  const doc = {
    bankId: "gs-c1-main",
    documentId: "6f1c1b7e-8c55-4a43-9b5e-0d8a1f1d7b10",
    content: "Kestrel Works pays on 30-day terms",
    context: null,
    tags: ["scope:agent:a1", "status:proposal"],
    entities: ["Kestrel Works"],
    metadata: { gsamRecordId: "6f1c1b7e-8c55-4a43-9b5e-0d8a1f1d7b10" },
    timestamp: "2026-10-04T10:00:00.000Z",
    mode: "chunks" as const,
  };

  it("signs every call with the key and a 60-second assertion scoped to one bank and its tags", async () => {
    const { fetchImpl, calls } = recordingFetch((url) =>
      url.endsWith("/memories/recall")
        ? json({ results: [{ document_id: doc.documentId, text: "hit", scores: { rerank: 0.7 } }, { text: "no doc id" }] })
        : json({ success: true, usage: { input_tokens: 0, output_tokens: 0 } }),
    );
    const engine = createHindsightMemoryEngine({ baseUrl: "http://127.0.0.1:18888/", apiKey: "k", assertionSecret: SECRET, fetchImpl });

    await engine.retain(doc);
    await engine.retain({ ...doc, documentId: "7f1c1b7e-8c55-4a43-9b5e-0d8a1f1d7b10" });
    const hits = await engine.recall({ bankId: doc.bankId, query: "terms", tags: ["scope:org", "scope:agent:a1"], limit: 5 });

    // The bank is configured once for its mode, then reused.
    expect(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      "PUT /v1/default/banks/gs-c1-main",
      "POST /v1/default/banks/gs-c1-main/memories",
      "POST /v1/default/banks/gs-c1-main/memories",
      "POST /v1/default/banks/gs-c1-main/memories/recall",
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ retain_extraction_mode: "chunks", enable_observations: false });
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
      expect(call.claims.bank).toBe("gs-c1-main");
      expect((call.claims.exp as number) - (call.claims.iat as number)).toBe(60);
    }
    expect(calls[1].claims).toMatchObject({ op: "retain", write: doc.tags, read: [], doc: doc.documentId });
    expect(JSON.parse(calls[1].init.body as string).items[0]).toMatchObject({
      document_id: doc.documentId,
      tags: doc.tags,
      entities: [{ text: "Kestrel Works" }],
      resolve_entities: false,
    });
    expect(calls[3].claims).toMatchObject({ op: "recall", read: ["scope:org", "scope:agent:a1"], write: [] });
    expect(JSON.parse(calls[3].init.body as string)).toMatchObject({ tags_match: "any_strict" });
    expect(hits).toEqual([{ documentId: doc.documentId, text: "hit", score: 0.7 }]);
  });

  it("switching to extract reconfigures the bank before the next retain", async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ success: true }));
    const engine = createHindsightMemoryEngine({ baseUrl: "http://e", apiKey: "k", assertionSecret: SECRET, fetchImpl });
    await engine.retain(doc);
    await engine.retain({ ...doc, mode: "extract" });
    const puts = calls.filter((call) => call.init.method === "PUT").map((call) => JSON.parse(call.init.body as string));
    expect(puts.map((body) => body.retain_extraction_mode)).toEqual(["chunks", "concise"]);
  });

  it("reports refused, failing, unreachable or slow engines as unavailable", async () => {
    for (const respond of [
      () => json({ detail: "Invalid API key" }, 401),
      () => json({ detail: "boom" }, 503),
      () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    ]) {
      const { fetchImpl } = recordingFetch(respond as never);
      const engine = createHindsightMemoryEngine({ baseUrl: "http://e", apiKey: "k", assertionSecret: SECRET, fetchImpl, timeoutMs: 50 });
      await expect(engine.recall({ bankId: "b", query: "q", tags: ["scope:org"], limit: 1 })).rejects.toBeInstanceOf(
        MemoryEngineUnavailableError,
      );
    }
  });

  it("keeps the raw engine status and detail so the outbox can classify the failure", async () => {
    const now = new Date("2026-10-04T10:00:00.000Z");
    const cases: Array<[Response, string]> = [
      [json({ detail: "You've hit your weekly limit · resets Oct 6, 12pm (UTC)" }, 500), "plan_limit"],
      [json({ detail: "content too large" }, 422), "rejected"],
      [json({ detail: "boom" }, 503), "engine_unavailable"],
    ];
    for (const [response, kind] of cases) {
      const { fetchImpl } = recordingFetch((url) => (url.endsWith("/memories") ? response : json({})));
      const engine = createHindsightMemoryEngine({ baseUrl: "http://e", apiKey: "k", assertionSecret: SECRET, fetchImpl });
      const error = await engine.retain(doc).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MemoryEngineUnavailableError);
      expect((error as MemoryEngineUnavailableError).status).toBe(response.status);
      expect(classifyEngineError(error, now).kind).toBe(kind);
    }
  });

  it("gives retain its own, longer timeout than recall", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ success: true, usage: { input_tokens: 12, output_tokens: 3 } })), 80);
        init.signal!.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      });
    const { fetchImpl } = recordingFetch((url, init) => (url.endsWith("/memories") || url.endsWith("/recall") ? hang(url, init) : json({})));
    const engine = createHindsightMemoryEngine({
      baseUrl: "http://e",
      apiKey: "k",
      assertionSecret: SECRET,
      fetchImpl,
      timeoutMs: 20,
      retainTimeoutMs: 1_000,
    });
    await expect(engine.retain(doc)).resolves.toEqual({ usage: { inputTokens: 12, outputTokens: 3 } });
    await expect(engine.recall({ bankId: "b", query: "q", tags: ["scope:org"], limit: 1 })).rejects.toBeInstanceOf(
      MemoryEngineUnavailableError,
    );
  });

  describe("gateway config file", () => {
    let dir: string;
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("reads an owner-only file and refuses one others can read", async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "gsam-memory-config-"));
      const file = path.join(dir, "gateway.env");
      await writeFile(
        file,
        'GSAM_MEMORY_ENGINE_URL=http://127.0.0.1:18888\nGSAM_MEMORY_ENGINE_API_KEY="k"\nGSAM_MEMORY_ASSERTION_SECRET=s\n',
      );
      await chmod(file, 0o600);
      expect(await readMemoryGatewayConfig(file)).toEqual({ baseUrl: "http://127.0.0.1:18888", apiKey: "k", assertionSecret: "s" });
      if (process.platform !== "win32") {
        await chmod(file, 0o644);
        expect(await readMemoryGatewayConfig(file)).toBeNull();
      }
      expect(await readMemoryGatewayConfig(path.join(dir, "missing.env"))).toBeNull();
    });

    it("without a config file every call is 'unavailable'", async () => {
      const engine = memoryEngineFromGatewayConfig(path.join(os.tmpdir(), `gsam-no-such-${Date.now()}.env`));
      await expect(engine.recall({ bankId: "b", query: "q", tags: ["t"], limit: 1 })).rejects.toBeInstanceOf(
        MemoryEngineUnavailableError,
      );
    });
  });

  const python = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!python)("the engine extension accepts what the gateway signs and nothing else", () => {
    const header = signMemoryAssertion(SECRET, { op: "retain", bank: "gs-c1-main", read: [], write: ["scope:org"], doc: null });
    const run = (env: Record<string, string>) =>
      spawnSync("python3", ["-m", "unittest", "test_gsam_memory_assertion.VerifyTests.test_accepts_the_typescript_signer"], {
        cwd: extensionDir,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
        encoding: "utf8",
      });
    expect(run({ GSAM_ASSERTION_FROM_TS: header, GSAM_ASSERTION_SECRET_FROM_TS: SECRET }).status).toBe(0);
    expect(run({ GSAM_ASSERTION_FROM_TS: header, GSAM_ASSERTION_SECRET_FROM_TS: "wrong" }).status).not.toBe(0);
  });
});
