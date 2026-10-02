import { useQuery } from "@tanstack/react-query";
import {
  AI_ACCESS_ROUTES,
  AI_ACCESS_ROUTE_DEFINITIONS,
  type AiAccessRoute,
} from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * One line per route. Typed by route so a new entry in `AI_ACCESS_ROUTES`
 * (GRE-165) fails the typecheck until it has a note here.
 */
const ROUTE_NOTES: Record<AiAccessRoute, string> = {
  claude_subscription: "Claude and Codex agents run on Claude with the Claude subscription connected in this install.",
  claude_api_key: "Claude and Codex agents run on Claude with the Anthropic API key connected in this install, billed per use.",
  codex_subscription: "Claude and Codex agents run on Codex with the ChatGPT subscription connected in this install.",
  codex_api_key: "Claude and Codex agents run on Codex with the OpenAI API key connected in this install, billed per use.",
};

const ROUTE_OPTIONS: ReadonlyArray<{ value: AiAccessRoute | null; label: string; note: string }> = [
  {
    value: null,
    label: "Each agent's own setup",
    note: "No install-wide route. Each agent keeps its own harness and AI connection.",
  },
  ...AI_ACCESS_ROUTES.map((route) => ({
    value: route,
    label: AI_ACCESS_ROUTE_DEFINITIONS[route].label,
    note: ROUTE_NOTES[route],
  })),
];

/**
 * Install-wide AI access route (GRE-139, GRE-339). Instance admins only; the
 * server refuses the PATCH for anyone else, this just keeps the control away
 * from people who cannot use it.
 */
export function AiAccessRouteSection({
  route,
  disabled,
  onChange,
}: {
  route: AiAccessRoute | null | undefined;
  disabled: boolean;
  onChange: (route: AiAccessRoute | null) => void;
}) {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  if (!boardAccess.data?.isInstanceAdmin) return null;

  const current = route ?? null;
  return (
    <section data-testid="ai-access-route-section">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">AI access route</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Choose how every Claude and Codex agent on this install reaches its AI model. Runs use only an
            account connected inside the install, never this computer's own login. A change applies from
            each agent's next run.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="AI access route">
          {ROUTE_OPTIONS.map((option) => {
            const active = current === option.value;
            return (
              <button
                key={option.value ?? "none"}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-foreground bg-accent text-foreground"
                    : "border-border bg-background hover:bg-accent/50",
                )}
                onClick={() => {
                  if (!active) onChange(option.value);
                }}
              >
                <div className="text-sm font-medium">{option.label}</div>
                <div className="text-xs text-muted-foreground">{option.note}</div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
