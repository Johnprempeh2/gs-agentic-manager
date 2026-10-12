// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeGoal } from "@/lib/goal-journey.fixtures";
import { KpiDraftNotice } from "./KpiDraftNotice";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
  useOptionalCompany: () => null,
}));

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const draft = makeGoal({
  kind: "kpi",
  status: "draft",
  benchmarkNote: "B1: peer median 24% (listed millers, FY2025)",
  sourceIssueId: "issue-1",
  sourceDocumentKey: "pre-read",
  sourceBulletId: "B1",
});

describe("KpiDraftNotice (GRE-1161)", () => {
  it("shows the benchmark as context and links back to the pack bullet", () => {
    const html = render(<KpiDraftNotice goal={draft} onAccept={() => {}} pending={false} />);
    expect(html).toContain("Benchmark (context, not a target)");
    expect(html).toContain("peer median 24%");
    expect(html).toContain('href="/issues/issue-1#document-pre-read"');
    expect(html).toContain("research pack pre-read, B1");
  });

  it("keeps Accept off until a target value and date are set", () => {
    const noTarget = render(<KpiDraftNotice goal={draft} onAccept={() => {}} pending={false} />);
    expect(noTarget).toContain("set a target value and date in Plan");
    expect(noTarget).toMatch(/<button[^>]*disabled=""[^>]*>Accept KPI/);

    const withTarget = render(
      <KpiDraftNotice goal={{ ...draft, targetValue: 22, targetDate: "2027-12-31" }} onAccept={() => {}} pending={false} />,
    );
    expect(withTarget).toContain("Target is set");
    expect(withTarget).not.toMatch(/<button[^>]*disabled=""[^>]*>Accept KPI/);
  });

  it("drops the draft line once the KPI is accepted, keeping benchmark and source", () => {
    const html = render(<KpiDraftNotice goal={{ ...draft, status: "active" }} onAccept={() => {}} pending={false} />);
    expect(html).not.toContain("Accept KPI");
    expect(html).toContain("peer median 24%");
  });
});
