import { AGENT_ROLE_LABELS, type Agent } from "@greatstone/shared";
import { AgentAvatar } from "./AgentAvatar";
import { EmptyState } from "./EmptyState";

type ChatAgent = Pick<Agent, "id" | "name" | "role" | "title" | "capabilities" | "appearance">;

export const AGENT_CHAT_STARTER_PROMPTS = [
  "What are you working on right now?",
  "What do you need from me to move faster?",
  "Summarise the last task you finished.",
] as const;

/** Role line under the name: the agent's own title, else the role label. */
export function agentChatRoleLine(agent: ChatAgent): string {
  return agent.title?.trim() || AGENT_ROLE_LABELS[agent.role] || agent.role;
}

/** One line on what the agent does: the first sentence of its capabilities. */
export function agentChatSummaryLine(agent: ChatAgent): string {
  const first = agent.capabilities?.trim().split(/(?<=[.!?])\s+|\n+/)[0]?.trim();
  return first || `Ask ${agent.name} about their work, or give them something new to do.`;
}

/** First screen of an empty agent chat (GRE-5833): who this is and what to ask. */
export function AgentChatEmptyState({ agent, onPrompt }: {
  agent: ChatAgent;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div data-testid="agent-chat-empty-state">
      <EmptyState
        media={(
          <div className="gs-empty-tile gs-glass-card mb-5 rounded-xl border p-3">
            <AgentAvatar agent={agent} size={48} />
          </div>
        )}
        title={agent.name}
        message={`${agentChatRoleLine(agent)} · ${agentChatSummaryLine(agent)}`}
      >
        <ul className="flex w-full max-w-md flex-col gap-2" aria-label="Starter prompts">
          {AGENT_CHAT_STARTER_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => onPrompt(prompt)}
                className="min-h-11 w-full rounded-lg border border-border bg-background/60 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </EmptyState>
    </div>
  );
}
