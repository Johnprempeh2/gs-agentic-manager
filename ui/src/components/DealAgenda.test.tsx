// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { PipelineCaseChildRow, PipelineListItem } from "../api/pipelines";
import { DealAgenda, buildDealAgenda } from "./DealAgenda";

const mocks = vi.hoisted(() => ({ listCases: vi.fn() }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: { listCases: mocks.listCases } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const working = { id: "s1", name: "Proposal", kind: "working" };
const won = { id: "s2", name: "Won", kind: "done" };
const row = (id: string, fields: Record<string, unknown>, stage = working) =>
  ({ case: { id, pipelineId: "p", title: id, stageId: stage.id, fields }, stage }) as unknown as PipelineCaseChildRow;

const rows = [
  row("Late", { dealStatus: "open", nextActivityDate: "2026-10-15", nextActivitySubject: "Call", dealOwner: "Ann", dealValue: 100, dealCurrency: "GBP" }),
  row("Today", { dealStatus: "open", nextActivityDate: "2026-10-18", dealOwner: "Ben" }),
  row("Tomorrow", { dealStatus: "open", nextActivityDate: "2026-10-19" }),
  row("Week", { dealStatus: "open", nextActivityDate: "2026-10-24" }),
  row("Later", { dealStatus: "open", nextActivityDate: "2026-11-30" }),
  row("Unbooked", { dealStatus: "open" }),
  row("WonDeal", { dealStatus: "won", nextActivityDate: "2026-10-10" }, won),
  row("Lead", { leadValue: 5 }),
];

describe("DealAgenda", () => {
  it("groups open deals by when their next step is due", () => {
    const buckets = buildDealAgenda([{ id: "p", name: "Deals", rows }], new Date(2026, 9, 18, 9));
    expect(buckets.map((bucket) => [bucket.key, bucket.items.map((item) => item.title)])).toEqual([
      ["overdue", ["Late"]],
      ["today", ["Today"]],
      ["tomorrow", ["Tomorrow"]],
      ["week", ["Week"]],
      ["later", ["Later"]],
      ["none", ["Unbooked"]],
    ]);
    expect(buckets[0]!.items[0]).toMatchObject({ subject: "Call", owner: "Ann", value: "100 GBP", pipelineName: "Deals", stageName: "Proposal" });
  });

  it("loads the deal pipelines only and filters by owner", async () => {
    mocks.listCases.mockResolvedValue(rows);
    const pipelines = [
      { id: "p", key: "pipedrive-1", name: "Deals", archivedAt: null },
      { id: "l", key: "pipedrive-leads", name: "Leads", archivedAt: null },
      { id: "c", key: "client-journey", name: "Clients", archivedAt: null },
    ] as unknown as PipelineListItem[];
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<QueryClientProvider client={new QueryClient()}><DealAgenda pipelines={pipelines} /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(mocks.listCases).toHaveBeenCalledTimes(1);
    expect(mocks.listCases).toHaveBeenCalledWith("p");
    expect(container.querySelectorAll("[data-testid='agenda-item']").length).toBe(6);
    const select = container.querySelector('select[aria-label="Show next steps for"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "Ann";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...container.querySelectorAll("[data-testid='agenda-item'] a")].map((link) => link.textContent)).toEqual(["Late"]);
    root.unmount();
  });
});
