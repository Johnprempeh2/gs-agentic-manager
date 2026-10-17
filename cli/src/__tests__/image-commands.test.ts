import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraFromOptions, numberedPath, registerImageCommands } from "../commands/client/image.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_ID = "66666666-6666-4666-8666-666666666666";
const ASSET_ID = "77777777-7777-4777-8777-777777777777";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerImageCommands(program);
  return program;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function image(status: "pending" | "completed" | "failed", extra: Record<string, unknown> = {}) {
  return {
    id: IMAGE_ID,
    companyId: COMPANY_ID,
    prompt: "A lighthouse at dawn",
    aspectRatio: "16:9",
    provider: "higgsfield",
    model: "higgsfield-ai/soul/standard",
    status,
    error: null,
    assetId: status === "completed" ? ASSET_ID : null,
    contentPath: status === "completed" ? `/api/assets/${ASSET_ID}/content` : null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: "2026-10-15T00:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

describe("gsam image", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.GSAM_API_KEY;
    process.env.GSAM_RUN_ID = "run-1";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.GSAM_RUN_ID;
  });

  it("makes an image, waits for it and attaches it to the task", async () => {
    let polls = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith(`/api/companies/${COMPANY_ID}/generated-images`)) return json(image("pending"), 202);
      if (url.endsWith(`/api/generated-images/${IMAGE_ID}`)) {
        polls += 1;
        return json(polls < 2 ? image("pending") : image("completed"));
      }
      if (url.endsWith(`/api/assets/${ASSET_ID}/content`)) {
        return new Response(new Uint8Array([0x89, 0x50, 1]), { headers: { "content-type": "image/png" } });
      }
      if (url.endsWith(`/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`)) {
        return json({ id: "attachment-1", contentPath: "/api/attachments/attachment-1/content" }, 201);
      }
      throw new Error(`unexpected ${url}`);
    }));

    const run = createProgram().parseAsync(
      ["image", "generate", "--prompt", "A lighthouse at dawn", "--shape", "wide", "--style", "Social post", "--issue-id", ISSUE_ID,
        "--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "agent-token"],
      { from: "user" },
    );
    await vi.runAllTimersAsync();
    await run;

    const create = calls[0]!;
    expect(JSON.parse(String(create.init?.body))).toEqual({
      prompt: "A lighthouse at dawn",
      aspectRatio: "16:9",
      style: "social-post",
      issueId: ISSUE_ID,
    });
    const upload = calls.find((call) => call.url.endsWith("/attachments"))!;
    expect(upload.init?.method).toBe("POST");
    expect((upload.init?.headers as Record<string, string>)["x-paperclip-run-id"]).toBe("run-1");
    const form = upload.init?.body as FormData;
    expect((form.get("file") as File).name).toBe("a-lighthouse-at-dawn.png");
  });

  it("rejects an unknown shape before calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createProgram().parseAsync(
        ["image", "generate", "--prompt", "x y z", "--shape", "hexagon", "--company-id", COMPANY_ID,
          "--api-base", "http://localhost:3100", "--api-key", "t"],
        { from: "user" },
      ),
    ).rejects.toThrow("exit");
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("makes several versions with camera settings and waits for each one", async () => {
    const created: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/companies/${COMPANY_ID}/generated-images`)) {
        created.push(JSON.parse(String(init?.body)));
        return json(image("pending", { id: `${IMAGE_ID.slice(0, -1)}${created.length}` }), 202);
      }
      const match = url.match(/generated-images\/([^/]+)$/);
      if (match) return json(image("completed", { id: match[1] }));
      if (url.endsWith(`/api/assets/${ASSET_ID}/content`)) {
        return new Response(new Uint8Array([0x89, 0x50, 1]), { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const run = createProgram().parseAsync(
      ["image", "generate", "--prompt", "A chef at work", "--camera", "16mm-film", "--lens", "Vintage Prime", "--focal", "50mm",
        "--aperture", "f/4", "--count", "2", "--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "t"],
      { from: "user" },
    );
    await vi.runAllTimersAsync();
    await run;

    expect(created).toHaveLength(2);
    expect(created[0]).toEqual({
      prompt: "A chef at work",
      aspectRatio: "1:1",
      camera: { camera: "16mm-film", lens: "vintage-prime", focalLength: 50, aperture: "f4" },
    });
  });

  it("reads camera flags and numbers output files", () => {
    expect(cameraFromOptions({})).toBeNull();
    expect(cameraFromOptions({ aperture: "f1.4", focal: "85" })).toEqual({ aperture: "f1.4", focalLength: 85 });
    expect(() => cameraFromOptions({ lens: "fisheye" })).toThrow(/Unknown lens/);
    expect(numberedPath("./out/image.png", 2)).toBe("./out/image-2.png");
    expect(numberedPath("image", 3)).toBe("image-3");
  });
});
