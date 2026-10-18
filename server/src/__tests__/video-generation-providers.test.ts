import { describe, expect, it, vi } from "vitest";
import { createGeneratedVideoSchema, composeVideoPrompt } from "@greatstone/shared";
import { createHiggsfieldVideoProvider } from "../services/video-generation/higgsfield.js";
import { describeVideoGeneration, resolveVideoGenerationProvider } from "../services/video-generation/registry.js";
import { sniffVideoType } from "../services/video-generation/types.js";
import { parseByteRangeHeader } from "../routes/byte-range.js";

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("higgsfield video provider", () => {
  it("uploads the picture, asks for image to video, polls and downloads the clip", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://api.higgsfield.ai/files/generate-upload-url") {
        return json({
          public_url: "https://cdn.example/in.png",
          upload_url: "https://upload.example/put",
          upload_headers: { "Content-Type": "image/png", "x-amz-tagging": "retention=temporary" },
        });
      }
      if (url === "https://upload.example/put") return new Response(null, { status: 200 });
      if (url === "https://api.higgsfield.ai/kling-video/v2.5-turbo/pro/image-to-video") {
        return json({ status: "queued", request_id: "vid-1", status_url: "https://api.higgsfield.ai/requests/vid-1/status" });
      }
      if (url.endsWith("/requests/vid-1/status")) {
        const polls = calls.filter((call) => call.url.endsWith("/status")).length;
        return polls < 2
          ? json({ status: "in_progress" })
          : json({ status: "completed", request_id: "vid-1", video: { url: "https://cdn.example/out.mp4" } });
      }
      if (url === "https://cdn.example/out.mp4") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      throw new Error(`unexpected ${url}`);
    });
    const provider = createHiggsfieldVideoProvider({ keyId: "id", keySecret: "secret", fetchImpl, sleep: async () => undefined });

    const result = await provider.generate({
      prompt: "The lighthouse beam sweeps the sea",
      model: "kling-2.5-turbo-pro",
      durationSeconds: 5,
      sourceImage: { bytes: PNG, contentType: "image/png" },
    });

    expect(result.providerRequestId).toBe("vid-1");
    expect(result.video.contentType).toBe("video/mp4");
    const upload = calls.find((call) => call.url === "https://upload.example/put")!;
    expect(upload.init?.method).toBe("PUT");
    expect((upload.init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect((upload.init?.headers as Record<string, string>)["x-amz-tagging"]).toBe("retention=temporary");
    const submit = calls.find((call) => call.url.endsWith("/image-to-video"))!;
    expect((submit.init?.headers as Record<string, string>).authorization).toBe("Key id:secret");
    expect(JSON.parse(String(submit.init?.body))).toEqual({
      prompt: "The lighthouse beam sweeps the sea",
      duration: 5,
      image_url: "https://cdn.example/in.png",
    });
  });

  it("uses the text path without an image and explains refusals plainly", async () => {
    const urls: string[] = [];
    const provider = createHiggsfieldVideoProvider({
      keyId: "id",
      keySecret: "secret",
      fetchImpl: async (url) => {
        urls.push(url);
        return json({ status: "nsfw", request_id: "vid-2" });
      },
    });
    await expect(
      provider.generate({ prompt: "x", model: "hailuo-2.3", durationSeconds: 6, sourceImage: null }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(urls).toEqual(["https://api.higgsfield.ai/minimax/hailuo-2.3/standard/text-to-video"]);
  });

  it("names a rejected key and an empty balance", async () => {
    const make = (status: number) =>
      createHiggsfieldVideoProvider({ keyId: "id", keySecret: "s", fetchImpl: async () => json({}, status) }).generate({
        prompt: "x",
        model: "hailuo-2.3",
        durationSeconds: 6,
        sourceImage: null,
      });
    await expect(make(401)).rejects.toMatchObject({ code: "auth" });
    await expect(make(402)).rejects.toMatchObject({ code: "credits" });
  });
});

describe("video provider choice", () => {
  it("follows practice mode and the Higgsfield key", () => {
    expect(resolveVideoGenerationProvider({})).toBeNull();
    expect(resolveVideoGenerationProvider({ GSAM_IMAGE_PROVIDER: "mock" })?.id).toBe("mock");
    expect(resolveVideoGenerationProvider({ HIGGSFIELD_API_KEY_ID: "a", HIGGSFIELD_API_KEY_SECRET: "b" })?.id).toBe("higgsfield");
    expect(
      resolveVideoGenerationProvider({ GSAM_IMAGE_PROVIDER: "openai", HIGGSFIELD_API_KEY_ID: "a", HIGGSFIELD_API_KEY_SECRET: "b" })?.id,
    ).toBe("higgsfield");
    expect(resolveVideoGenerationProvider({ GSAM_VIDEO_PROVIDER: "mock", HIGGSFIELD_API_KEY: "a:b" })?.id).toBe("mock");
    expect(describeVideoGeneration(null)).toEqual({ configured: false, provider: null, providerLabel: null, local: null });
  });

  it("makes a playable practice clip", async () => {
    const result = await resolveVideoGenerationProvider({ GSAM_VIDEO_PROVIDER: "mock" })!.generate({
      prompt: "x",
      model: "hailuo-2.3",
      durationSeconds: 6,
      sourceImage: null,
    });
    expect(sniffVideoType(result.video.bytes)).toBe("video/mp4");
    expect(result.video.bytes.length).toBeGreaterThan(1000);
  });
});

describe("video request rules", () => {
  it("checks the duration against the model and needs an image for image-only models", () => {
    expect(createGeneratedVideoSchema.safeParse({ prompt: "A cat", model: "hailuo-2.3", duration: 5 }).success).toBe(false);
    expect(createGeneratedVideoSchema.safeParse({ prompt: "A cat", model: "kling-2.5-turbo-standard" }).success).toBe(false);
    expect(
      createGeneratedVideoSchema.safeParse({
        prompt: "A cat",
        model: "kling-2.5-turbo-standard",
        sourceImageId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(createGeneratedVideoSchema.parse({ prompt: "A cat" }).model).toBe("kling-2.5-turbo-pro");
  });

  it("adds motion and camera words after the description", () => {
    expect(composeVideoPrompt("Waves on rocks.", "drone", { focalLength: 24 })).toBe(
      "Waves on rocks, aerial drone shot rising and revealing the scene, at 24mm (wide-angle dynamic perspective), cinematic lighting, natural colour science, high dynamic range",
    );
    expect(composeVideoPrompt("Waves", null, null)).toBe("Waves");
  });

  it("parses byte ranges", () => {
    expect(parseByteRangeHeader(undefined, 10)).toEqual({ kind: "none" });
    expect(parseByteRangeHeader("bytes=0-", 10)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseByteRangeHeader("bytes=-3", 10)).toEqual({ kind: "range", start: 7, end: 9 });
    expect(parseByteRangeHeader("bytes=5-100", 10)).toEqual({ kind: "range", start: 5, end: 9 });
    expect(parseByteRangeHeader("bytes=0-1,4-5", 10)).toEqual({ kind: "invalid" });
  });
});
