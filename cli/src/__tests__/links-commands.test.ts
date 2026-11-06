import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLinksCommands } from "../commands/client/links.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "66666666-6666-4666-8666-666666666666";
const BASE = ["--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "t"];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerLinksCommands(program);
  return program;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("gsam links", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("searches with the query and filters", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return json({ links: [], total: 0, facets: { clients: [], projects: [] } });
    }));
    await createProgram().parseAsync(["links", "search", "netlify", "--type", "Demo", "--archived", ...BASE], { from: "user" });
    expect(urls).toEqual([
      `http://localhost:3100/api/companies/${COMPANY_ID}/links?q=netlify&type=demo&includeArchived=true`,
    ]);
  });

  it("adds a link with the current task as its source", async () => {
    vi.stubEnv("GSAM_TASK_ID", ISSUE_ID);
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ id: "l1", title: "Acme site", url: "https://acme.netlify.app/", type: "demo", status: "live" }, 201);
    }));
    await createProgram().parseAsync(
      ["links", "add", "--url", "https://acme.netlify.app", "--title", "Acme site", "--type", "demo", "--notes", "Sent Monday", ...BASE],
      { from: "user" },
    );
    expect(bodies).toEqual([
      { url: "https://acme.netlify.app", title: "Acme site", type: "demo", sourceIssueId: ISSUE_ID, notes: "Sent Monday" },
    ]);
  });
});
