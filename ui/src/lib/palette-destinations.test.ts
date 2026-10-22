import { describe, expect, it } from "vitest";
import { PALETTE_PAGES, PALETTE_SETTINGS_PAGES, rankDestinations, type PaletteDestination } from "./palette-destinations";

const project: PaletteDestination = { kind: "project", id: "p1", label: "Client portal", path: "/projects/client-portal", detail: "Sign-in for clients" };
const task = (id: string, key: string, label: string): PaletteDestination => ({ kind: "task", id, key, label, path: `/issues/${key}` });
const all = [...PALETTE_PAGES, ...PALETTE_SETTINGS_PAGES, project, task("t1", "GRE-12", "Audit the portal"), task("t2", "GRE-120", "Portal copy"), task("t3", "GRE-7", "Portal emails")];
const top = (q: string) => rankDestinations(q, all, 6).map((d) => d.label);

describe("rankDestinations", () => {
  it("puts a whole-name match first and finds pages by the sidebar's name or an old one", () => {
    expect(top("members")[0]).toBe("Members");
    expect(top("Decisions")[0]).toBe("Decisions");
    expect(top("activity")[0]).toBe("Audit");
  });

  it("finds a task by its key, exactly or by its start", () => {
    expect(rankDestinations("gre-12", all, 6)[0]!.id).toBe("t1");
    expect(rankDestinations("GRE-1", all, 6).map((d) => d.id)).toEqual(["t1", "t2"]);
  });

  it("ranks a short project name above longer tasks that share the word, and caps tasks at two", () => {
    const found = rankDestinations("portal", all, 6);
    expect(found[0]).toBe(project);
    expect(found.filter((d) => d.kind === "task")).toHaveLength(2);
  });

  it("only matches word starts, so a fragment inside a word finds nothing", () => {
    expect(top("ortal")).toEqual([]);
  });
});
