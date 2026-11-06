import { describe, expect, it } from "vitest";
import type { LinkItem } from "@greatstone/shared";
import { groupLinksByClient, shortLinkUrl } from "./links-register";

function link(id: string, client: Partial<Pick<LinkItem, "clientCase" | "clientName">> = {}): LinkItem {
  return {
    id,
    companyId: "c",
    url: `https://${id}.netlify.app/`,
    title: id,
    type: "demo",
    status: "live",
    source: "manual",
    clientCase: client.clientCase ?? null,
    clientName: client.clientName ?? null,
    project: null,
    projectName: null,
    sourceIssue: null,
    addedBy: null,
    notes: null,
    deployedAt: null,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

describe("groupLinksByClient", () => {
  it("groups by client A to Z, keeps order inside a group and puts links with no client last", () => {
    const groups = groupLinksByClient([
      link("a", { clientCase: { id: "z1", name: "Zenith Labs" } }),
      link("b"),
      link("c", { clientCase: { id: "a1", name: "Acme Clinic" } }),
      link("d", { clientCase: { id: "z1", name: "Zenith Labs" } }),
      link("e", { clientName: "bakery co" }),
      link("f", { clientName: "Bakery Co" }),
    ]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Acme Clinic", ["c"]],
      ["bakery co", ["e", "f"]],
      ["Zenith Labs", ["a", "d"]],
      ["No client", ["b"]],
    ]);
  });
});

describe("shortLinkUrl", () => {
  it("drops the scheme and a bare trailing slash", () => {
    expect(shortLinkUrl("https://acme.netlify.app/")).toBe("acme.netlify.app");
    expect(shortLinkUrl("https://acme.netlify.app/deck/?v=2")).toBe("acme.netlify.app/deck?v=2");
  });
});
