import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerImageCommands } from "../commands/client/image.js";
import { registerLookCommands } from "../commands/client/look.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const LOOK_ID = "77777777-7777-4777-8777-777777777777";
const BASE = ["--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "t"];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerImageCommands(program);
  registerLookCommands(program);
  return program;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("gsam look", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves a look with camera flags and words", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ id: LOOK_ID, name: "Acme" }, 201);
    }));
    await createProgram().parseAsync(
      ["look", "save", "--name", "Acme", "--style", "photo", "--lens", "vintage-prime", "--words", "navy and gold", ...BASE],
      { from: "user" },
    );
    expect(bodies).toEqual([{ name: "Acme", style: "photo", camera: { lens: "vintage-prime" }, words: "navy and gold" }]);
  });

  it("finds a look by name for gsam image generate", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/studio-looks")) return json({ looks: [{ id: LOOK_ID, name: "Acme Product" }] });
      posted.push(JSON.parse(String(init?.body)));
      return json({ id: "img-1", status: "pending" }, 202);
    }));
    await createProgram().parseAsync(
      ["image", "generate", "--prompt", "A bottle of oil", "--look", "acme product", "--no-wait", ...BASE],
      { from: "user" },
    );
    expect(posted).toEqual([{ prompt: "A bottle of oil", aspectRatio: "1:1", lookId: LOOK_ID }]);
  });

  it("names the saved looks when the one asked for does not exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ looks: [{ id: LOOK_ID, name: "Acme Product" }] })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      createProgram().parseAsync(["image", "generate", "--prompt", "A cat on a mat", "--look", "Spring", ...BASE], { from: "user" }),
    ).rejects.toThrow("exit");
    expect(errors.join(" ")).toContain("Saved looks: Acme Product");
  });
});
