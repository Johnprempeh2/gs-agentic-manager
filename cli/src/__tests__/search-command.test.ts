import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSearchCommands } from "../commands/client/search.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSearchCommands(program);
  return program;
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function run(args: string[]) {
  return createProgram().parseAsync(
    [...args, "--company-id", COMPANY_ID, "--api-base", "http://localhost:3100", "--api-key", "agent-token"],
    { from: "user" },
  );
}

describe("gsam search", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    delete process.env.GSAM_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("searches the company and prints each result with what it is and where it lives", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return json({
        hasMore: true,
        results: [
          { id: "i1", type: "issue", title: "Acme renewal deck", href: "/GRE/issues/GRE-12", snippet: "Prepare the  Acme deck", issue: { identifier: "GRE-12" } },
          { id: "organisation:o1", type: "record", title: "Acme Ltd", href: "/GRE/organisations/o1", snippet: null, record: { kind: "organisation", subtitle: "Mining, Ghana" } },
          { id: "activity:a1", type: "record", title: "Pricing call", href: "/GRE/pipelines/p/items/c", snippet: "Agreed the tier", record: { kind: "activity", subtitle: "Call, Acme renewal, 12 Oct 2026" } },
          { id: "file:f1", type: "file", title: "nda.pdf", href: "/GRE/organisations/o1", snippet: "Acme confidential", file: { owner: { kind: "organisation", label: "Acme Ltd", href: "" } } },
        ],
      });
    }));

    await run(["search", "acme", "renewal", "--scope", "all", "--limit", "4"]);

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/search`);
    expect(url.searchParams.get("q")).toBe("acme renewal");
    expect(url.searchParams.get("scope")).toBe("all");
    expect(url.searchParams.get("limit")).toBe("4");
    expect(lines[0]).toBe("Task | GRE-12 Acme renewal deck  /GRE/issues/GRE-12\n    Prepare the Acme deck");
    expect(lines[1]).toBe("Organisation | Acme Ltd | Mining, Ghana  /GRE/organisations/o1");
    expect(lines[2]).toContain("Note or activity | Pricing call | Call, Acme renewal, 12 Oct 2026");
    expect(lines[3]).toContain("In file | nda.pdf | Acme Ltd");
    expect(lines[4]).toContain("More results");
  });

  it("says so when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ results: [], hasMore: false })));
    await run(["search", "zebra", "--scope", "records"]);
    expect(lines).toEqual(['Nothing found for "zebra".']);
  });

  it("narrows to record kinds and switches to records", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return json({ results: [], hasMore: false }); }));
    await run(["search", "acme", "--kind", "person, activity"]);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("scope")).toBe("records");
    expect(url.searchParams.get("recordKind")).toBe("person,activity");
  });

  it("lists quiet clients with stage, last contact and link", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return json({
        days: 14,
        total: 2,
        clients: [
          { caseId: "c1", title: "Rollout", pipelineId: "p", pipelineName: "Sales", stageName: "Proposal", organisationName: "Heron Ltd", lastTouchAt: "2026-08-29T09:00:00.000Z", lastTouchLabel: "Call: Pricing call", quietDays: 50, href: "/GRE/pipelines/p/items/c1" },
          { caseId: "c2", title: "Wren lead", pipelineId: "p", pipelineName: "Sales", stageName: "Lead", organisationName: null, lastTouchAt: null, lastTouchLabel: null, quietDays: 1, href: "/GRE/pipelines/p/items/c2" },
        ],
      });
    }));
    await run(["quiet-clients", "--days", "14"]);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe(`/api/companies/${COMPANY_ID}/search/quiet-clients`);
    expect(url.searchParams.get("days")).toBe("14");
    expect(lines).toEqual([
      "2 open deals and leads with no note, call or meeting in 14 days:",
      "Rollout (Heron Ltd) | Proposal in Sales | last Call: Pricing call, 50 days ago  /GRE/pipelines/p/items/c1",
      "Wren lead | Lead in Sales | no notes or calls yet, added 1 day ago  /GRE/pipelines/p/items/c2",
    ]);
  });

  it("prints a client brief", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return json({
        brief: {
          organisation: { id: "o1", name: "Grebe", status: "client", industry: "Mining", country: "Ghana", href: "/GRE/organisations/o1" },
          people: [{ name: "Yaw Darko", role: "CFO", email: null }],
          peopleCount: 1,
          openDeals: [{ title: "Grebe expansion", stageName: "Proposal", pipelineName: "Sales", href: "/GRE/pipelines/p/items/c1" }],
          lastTouch: { at: "2026-10-08T09:00:00.000Z", label: "Meeting: Quarterly review" },
          quietDays: 10,
        },
      });
    }));
    await run(["client-brief", "grebe"]);
    expect(new URL(urls[0]!).searchParams.get("q")).toBe("grebe");
    expect(lines).toEqual([
      "Grebe (client, Mining, Ghana)  /GRE/organisations/o1",
      "Last contact: Meeting: Quarterly review, 10 days ago",
      "Open deals: Grebe expansion (Proposal in Sales)",
      "People (1): Yaw Darko, CFO",
    ]);
  });
});
