// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StrategyBoardAgent } from "@greatstone/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AskBoardAgentButton } from "./StrategyBoard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => () => undefined,
  useSearchParams: () => [new URLSearchParams(), () => undefined],
}));

function render(agents: StrategyBoardAgent[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.strategyBoard.agents("c1"), agents);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AskBoardAgentButton companyId="c1" />
    </QueryClientProvider>,
  );
}

const secretary: StrategyBoardAgent = { id: "a-sec", name: "Board secretary", title: "Secretary", icon: null };
const evidence: StrategyBoardAgent = { id: "a-ev", name: "Revenue evidence agent", title: null, icon: null };

describe("Ask the board agent (GRE-1186)", () => {
  it("shows nothing to someone with no board agents", () => {
    expect(render([])).toBe("");
  });

  it("links straight to the chat when the board member has one agent", () => {
    const html = render([secretary]);
    expect(html).toContain("Ask the board agent");
    expect(html).toContain('href="/strategy-board/ask/a-sec"');
  });

  it("opens a menu of the board member's own agents when there are several", () => {
    const html = render([secretary, evidence]);
    expect(html).toContain("Ask the board agent");
    expect(html).not.toContain("href=");
    expect(html).toContain('aria-haspopup="menu"');
  });
});
