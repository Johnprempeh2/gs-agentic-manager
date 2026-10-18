// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PipelineStage } from "../api/pipelines";
import { DealsList, buildDealRows, sortDealRows } from "./DealsList";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stages = [
  { id: "s1", name: "Qualified", kind: "working", position: 0 },
  { id: "s2", name: "Proposal", kind: "working", position: 1 },
  { id: "won", name: "Won", kind: "done", position: 2 },
] as PipelineStage[];

const cases = [
  { id: "a", pipelineId: "p", title: "Acme", stageId: "s2", stageEnteredAt: "2026-10-10T12:00:00Z", fields: { dealValue: 5000, dealCurrency: "GBP", probability: 40, nextActivityDate: "2026-10-20", nextActivitySubject: "Demo" } },
  { id: "b", pipelineId: "p", title: "Beta", stageId: "s1", stageEnteredAt: "2026-10-16T12:00:00Z", fields: { dealValue: 9000, dealCurrency: "GBP", nextActivityDate: "2026-10-18" } },
  { id: "c", pipelineId: "p", title: "Corp", stageId: "won", stageEnteredAt: "2026-09-01T12:00:00Z", fields: { dealStatus: "Won" } },
];

describe("DealsList", () => {
  it("builds rows with weighted value and days in stage, and sorts with blanks last", () => {
    const rows = buildDealRows(cases, stages, new Date("2026-10-17T12:00:00Z"));
    expect(rows.map((row) => [row.item.title, row.stageName, row.weighted, row.days])).toEqual([
      ["Acme", "Proposal", 2000, 7],
      ["Beta", "Qualified", null, 1],
      ["Corp", "Won", null, null],
    ]);
    expect(sortDealRows(rows, "value", "desc").map((row) => row.item.title)).toEqual(["Beta", "Acme", "Corp"]);
    expect(sortDealRows(rows, "value", "asc").map((row) => row.item.title)).toEqual(["Acme", "Beta", "Corp"]);
    expect(sortDealRows(rows, "stage", "asc").map((row) => row.item.title)).toEqual(["Beta", "Acme", "Corp"]);
  });

  it("lists deals by next step first and re-sorts when a header is clicked", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<DealsList cases={cases} stages={stages} />));
    const titles = () => [...container.querySelectorAll("[data-testid='deal-row'] a")].map((link) => link.textContent);
    expect(titles()).toEqual(["Beta", "Acme", "Corp"]);
    const header = [...container.querySelectorAll("th button")].find((button) => button.textContent === "Deal")!;
    await act(async () => (header as HTMLButtonElement).click());
    expect(titles()).toEqual(["Acme", "Beta", "Corp"]);
    root.unmount();
  });
});
