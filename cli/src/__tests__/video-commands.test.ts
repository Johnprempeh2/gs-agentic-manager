import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVideoCommands } from "../commands/client/video.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const IMAGE_ID = "33333333-3333-4333-8333-333333333333";
const VIDEO_ID = "66666666-6666-4666-8666-666666666666";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerVideoCommands(program);
  return program;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("gsam video", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("animates an image with motion and camera, and waits for the clip", async () => {
    const bodies: unknown[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/companies/${COMPANY_ID}/generated-videos`)) {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ id: VIDEO_ID, status: "pending" }, 202);
      }
      if (url.endsWith(`/api/generated-videos/${VIDEO_ID}`)) {
        polls += 1;
        return json(polls < 2 ? { id: VIDEO_ID, status: "pending" } : { id: VIDEO_ID, status: "completed", assetId: "asset-1" });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const run = createProgram().parseAsync(
      ["video", "generate", "--prompt", "The boat drifts", "--model", "kling-2.5-turbo-standard", "--duration", "10", "--image", IMAGE_ID,
        "--motion", "orbit", "--lens", "vintage-prime", "--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "t"],
      { from: "user" },
    );
    await vi.runAllTimersAsync();
    await run;

    expect(bodies).toEqual([
      {
        prompt: "The boat drifts",
        model: "kling-2.5-turbo-standard",
        duration: 10,
        motion: "orbit",
        camera: { lens: "vintage-prime" },
        sourceImageId: IMAGE_ID,
      },
    ]);
    expect(polls).toBe(2);
  });

  it("stars a favourite clip and lists only favourites", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/generated-videos?")) return json({ videos: [], total: 0, nextOffset: null });
      return json({ id: VIDEO_ID, favourite: true });
    }));
    const base = ["--api-base", "http://localhost:3100", "--api-key", "t"];

    await createProgram().parseAsync(["video", "favourite", VIDEO_ID, ...base], { from: "user" });
    await createProgram().parseAsync(["video", "list", "--favourites", "--company-id", COMPANY_ID, ...base], { from: "user" });

    expect(calls[0]).toMatchObject({ url: `http://localhost:3100/api/generated-videos/${VIDEO_ID}/favourite`, method: "PATCH", body: { favourite: true } });
    expect(calls[1]!.url).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/generated-videos?limit=20&favourite=true`);
  });

  it("refuses an image-only model without an image before calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createProgram().parseAsync(
        ["video", "generate", "--prompt", "x y z", "--model", "kling-2.5-turbo-standard", "--company-id", COMPANY_ID,
          "--api-base", "http://localhost:3100", "--api-key", "t"],
        { from: "user" },
      ),
    ).rejects.toThrow("exit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
