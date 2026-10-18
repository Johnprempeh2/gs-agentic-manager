import { describe, expect, it } from "vitest";
import type { Deliverable } from "@greatstone/shared";
import { deliverablesListText } from "./deliverables-text";

const item = (over: Partial<Deliverable>) => ({ id: "d", title: "Doc", project: null, clientCase: null, ...over }) as Deliverable;

describe("deliverablesListText", () => {
  it("lists each document under its group with where it belongs and a link", () => {
    const text = deliverablesListText(
      [
        { label: "This week", items: [item({ id: "1", title: "Board pack", project: { id: "p", name: "Website relaunch" } })] },
        { label: null, items: [item({ id: "2", title: "Proposal", clientCase: { id: "c", name: "Acme" } })] },
      ],
      (d) => `https://gsam.test/d/${d.id}`,
      new Date(2026, 9, 16),
    );
    expect(text.split("\n")).toEqual([
      "Deliverables, 16 Oct",
      "2 deliverables.",
      "",
      "This week",
      "• Board pack, Website relaunch https://gsam.test/d/1",
      "",
      "• Proposal, Acme https://gsam.test/d/2",
    ]);
  });
});
