import { describe, expect, it, vi } from "vitest";
import { createHiggsfieldProvider, higgsfieldCredentialsFromEnv } from "../services/image-generation/higgsfield.js";
import { createOpenAiImageProvider } from "../services/image-generation/openai.js";
import { describeImageGeneration, resolveImageGenerationProvider } from "../services/image-generation/registry.js";
import { ImageGenerationError } from "../services/image-generation/types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("higgsfield provider", () => {
  it("submits, polls the status url and downloads the image", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://api.higgsfield.ai/higgsfield-ai/soul/standard") {
        return json({ status: "queued", request_id: "req-1", status_url: "https://api.higgsfield.ai/requests/req-1/status" });
      }
      if (url.endsWith("/requests/req-1/status")) {
        const polls = calls.filter((call) => call.url.endsWith("/status")).length;
        return polls < 2
          ? json({ status: "in_progress", request_id: "req-1" })
          : json({ status: "completed", request_id: "req-1", images: [{ url: "https://cdn.example/out.png" }] });
      }
      if (url === "https://cdn.example/out.png") {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const provider = createHiggsfieldProvider({
      keyId: "id",
      keySecret: "secret",
      fetchImpl,
      sleep: async () => undefined,
    });

    const result = await provider.generate({ prompt: "A lighthouse at dawn", aspectRatio: "16:9" });

    expect(result.providerRequestId).toBe("req-1");
    expect(result.image.contentType).toBe("image/png");
    expect(result.image.bytes.equals(PNG)).toBe(true);
    const submit = calls[0]!;
    expect((submit.init?.headers as Record<string, string>).authorization).toBe("Key id:secret");
    expect(JSON.parse(String(submit.init?.body))).toEqual({
      prompt: "A lighthouse at dawn",
      aspect_ratio: "16:9",
      num_images: 1,
    });
  });

  it("explains a content-rule refusal in plain words", async () => {
    const provider = createHiggsfieldProvider({
      keyId: "id",
      keySecret: "secret",
      fetchImpl: async () => json({ status: "nsfw", request_id: "req-2" }),
    });
    await expect(provider.generate({ prompt: "something", aspectRatio: "1:1" })).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringContaining("content rules"),
    });
  });

  it("maps a rejected key and an empty account to clear messages", async () => {
    for (const [status, code] of [[401, "auth"], [402, "credits"], [429, "rate_limited"]] as const) {
      const provider = createHiggsfieldProvider({ keyId: "id", keySecret: "secret", fetchImpl: async () => json({}, status) });
      const error = await provider.generate({ prompt: "x y z", aspectRatio: "1:1" }).catch((caught) => caught);
      expect(error).toBeInstanceOf(ImageGenerationError);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("secret");
    }
  });

  it("gives up after the timeout", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const provider = createHiggsfieldProvider({
      keyId: "id",
      keySecret: "secret",
      timeoutMs: 1_000,
      sleep: async () => {
        now += 600;
      },
      fetchImpl: async () => json({ status: "queued", request_id: "r", status_url: "https://api.higgsfield.ai/requests/r/status" }),
    });
    await expect(provider.generate({ prompt: "slow one", aspectRatio: "1:1" })).rejects.toMatchObject({ code: "timeout" });
    vi.restoreAllMocks();
  });

  it("reads credentials from separate or combined variables", () => {
    expect(higgsfieldCredentialsFromEnv({ HIGGSFIELD_API_KEY_ID: "a", HIGGSFIELD_API_KEY_SECRET: "b" })).toEqual({ keyId: "a", keySecret: "b" });
    expect(higgsfieldCredentialsFromEnv({ HF_API_KEY_ID: "c", HF_API_KEY_SECRET: "d" })).toEqual({ keyId: "c", keySecret: "d" });
    expect(higgsfieldCredentialsFromEnv({ HIGGSFIELD_API_KEY: "e:f" })).toEqual({ keyId: "e", keySecret: "f" });
    expect(higgsfieldCredentialsFromEnv({ HIGGSFIELD_API_KEY: "nocolon" })).toBeNull();
    expect(higgsfieldCredentialsFromEnv({})).toBeNull();
  });
});

describe("openai image provider", () => {
  it("asks for the closest size and decodes the image", async () => {
    let body: Record<string, unknown> = {};
    const provider = createOpenAiImageProvider({
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return json({ data: [{ b64_json: PNG.toString("base64") }] });
      },
    });
    const result = await provider.generate({ prompt: "poster", aspectRatio: "3:4" });
    expect(body).toMatchObject({ model: "gpt-image-1", size: "1024x1536", n: 1 });
    expect(result.image.contentType).toBe("image/png");
  });
});

describe("provider selection", () => {
  it("is off with no key", () => {
    expect(resolveImageGenerationProvider({})).toBeNull();
    expect(describeImageGeneration(null)).toEqual({ configured: false, provider: null, providerLabel: null, model: null });
  });

  it("picks Higgsfield on its own when its key is set", () => {
    const provider = resolveImageGenerationProvider({ HIGGSFIELD_API_KEY: "a:b", HIGGSFIELD_IMAGE_MODEL: "higgsfield-ai/soul/v2/standard" });
    expect(provider?.id).toBe("higgsfield");
    expect(provider?.model).toBe("higgsfield-ai/soul/v2/standard");
    expect(describeImageGeneration(provider).providerLabel).toBe("Higgsfield");
  });

  it("never spends an agent OpenAI key unless OpenAI is named", () => {
    expect(resolveImageGenerationProvider({ OPENAI_API_KEY: "sk" })).toBeNull();
    expect(resolveImageGenerationProvider({ OPENAI_API_KEY: "sk", GSAM_IMAGE_PROVIDER: "openai" })?.id).toBe("openai");
  });

  it("offers practice mode only when asked for", () => {
    expect(resolveImageGenerationProvider({ GSAM_IMAGE_PROVIDER: "mock" })?.id).toBe("mock");
  });
});
