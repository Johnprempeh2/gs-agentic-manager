// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PipelineStage } from "../api/pipelines";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DealsList, buildDealRows, bulkMoveStages, sortDealRows, withDealForecast, withDealOwner } from "./DealsList";

const mocks = vi.hoisted(() => ({ updateCase: vi.fn(), transitionCase: vi.fn(), pushToast: vi.fn() }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: { updateCase: mocks.updateCase, transitionCase: mocks.transitionCase } }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mocks.pushToast }) }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stages = [
  { id: "s1", key: "qualified", name: "Qualified", kind: "working", position: 0 },
  { id: "s2", key: "proposal", name: "Proposal", kind: "working", position: 1 },
  { id: "won", key: "won", name: "Won", kind: "done", position: 2 },
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
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><DealsList cases={cases} stages={stages} /></QueryClientProvider>));
    const titles = () => [...container.querySelectorAll("[data-testid='deal-row'] a")].map((link) => link.textContent);
    expect(titles()).toEqual(["Beta", "Acme", "Corp"]);
    const header = [...container.querySelectorAll("th button")].find((button) => button.textContent === "Deal")!;
    await act(async () => (header as HTMLButtonElement).click());
    expect(titles()).toEqual(["Acme", "Beta", "Corp"]);
    root.unmount();
  });

  it("keeps a lead's owner key when the owner changes", () => {
    expect(withDealOwner({ leadValue: 1, leadOwner: "Ann" }, " Ben ")).toEqual({ leadValue: 1, leadOwner: "Ben" });
    expect(withDealOwner({ dealOwner: "Ann" }, "Ben")).toEqual({ dealOwner: "Ben" });
    expect(withDealOwner({ dealOwner: "Ann" }, "")).toEqual({});
  });

  it("changes the owner of the selected deals", async () => {
    mocks.updateCase.mockResolvedValue({});
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><DealsList cases={cases} stages={stages} /></QueryClientProvider>));
    const box = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    await act(async () => box("Select Acme").click());
    await act(async () => box("Select Beta").click());
    const input = container.querySelector('input[aria-label="New owner"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Ben");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('form[aria-label="Change owner"]') as HTMLFormElement).requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(mocks.updateCase.mock.calls.map((call) => [call[0], call[1].fields.dealOwner])).toEqual([["b", "Ben"], ["a", "Ben"]]);
    expect(mocks.pushToast).toHaveBeenCalledWith({ title: "Owner changed on 2 deals", tone: "success" });
    root.unmount();
  });

  it("sets close date and probability, leaving blank inputs alone", () => {
    expect(withDealForecast({ probability: 20 }, { expectedClose: "2026-11-30", probability: "" })).toEqual({ probability: 20, expectedCloseDate: "2026-11-30" });
    expect(withDealForecast({ expectedCloseDate: "2026-11-01" }, { expectedClose: "", probability: "60" })).toEqual({ expectedCloseDate: "2026-11-01", probability: 60 });
    expect(() => withDealForecast({}, { expectedClose: "", probability: "120" })).toThrow("Probability must be between 0 and 100");
  });

  it("sets the close date on the selected open deals and leaves won deals alone", async () => {
    mocks.updateCase.mockReset();
    mocks.updateCase.mockResolvedValue({});
    mocks.pushToast.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><DealsList cases={cases} stages={stages} /></QueryClientProvider>));
    await act(async () => (container.querySelector('[aria-label="Select every deal"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="Expected close"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "2026-11-30");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('form[aria-label="Set close date and probability"]') as HTMLFormElement).requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(mocks.updateCase.mock.calls.map((call) => [call[0], call[1].fields.expectedCloseDate])).toEqual([["b", "2026-11-30"], ["a", "2026-11-30"]]);
    expect(mocks.pushToast).toHaveBeenCalledWith({ title: "Updated 2 deals", body: "1 won or lost deal was left as it was.", tone: "info" });
    root.unmount();
  });

  it("offers only open stages for a bulk move", () => {
    expect(bulkMoveStages(stages).map((stage) => stage.id)).toEqual(["s1", "s2"]);
  });

  it("moves the selected deals to a stage and reports the ones a rule stopped", async () => {
    mocks.pushToast.mockClear();
    mocks.transitionCase.mockReset();
    mocks.transitionCase.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("gate"));
    const extra = { id: "d", pipelineId: "p", title: "Delta", stageId: "s1", stageEnteredAt: "2026-10-16T12:00:00Z", fields: {} };
    const versioned = [...cases, extra].map((item, index) => ({ ...item, version: index + 3 }));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><DealsList cases={versioned} stages={stages} /></QueryClientProvider>));
    const box = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    await act(async () => box("Select every deal").click());
    const select = container.querySelector('select[aria-label="Stage to move to"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "s2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('form[aria-label="Move to stage"]') as HTMLFormElement).requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Acme is already in Proposal and Corp is won, so only Beta and Delta are sent.
    expect(mocks.transitionCase.mock.calls.map((call) => call[0]).sort()).toEqual(["b", "d"]);
    expect(mocks.transitionCase).toHaveBeenCalledWith("b", { toStageKey: "proposal", expectedVersion: 4 });
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Moved 1 deal to Proposal",
      tone: "warn",
      body: expect.stringContaining("1 won or lost deal was left as it was."),
    }));
    root.unmount();
  });
});
