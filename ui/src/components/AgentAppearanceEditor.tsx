import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Palette } from "lucide-react";
import { characterStateForAgent, resolveAgentAppearance, type AgentAppearance } from "@greatstone/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AgentCharacter } from "./AgentCharacter";
import { AgentAppearancePicker } from "./AgentAppearancePicker";
import type { AvatarAgent } from "./AgentAvatar";

type EditableAgent = AvatarAgent & { id: string; name: string; status: string };

interface AgentAppearanceEditorProps {
  agent: EditableAgent;
  companyId?: string | null;
  /** Rendered character size in the trigger. */
  size?: 64 | 96;
}

/**
 * The agent's hero character as a button that opens the colour picker.
 * Saving PATCHes only `appearance`; the avatar URL carries the palette id, so
 * refreshing the agent queries re-renders every avatar of this agent.
 */
export function AgentAppearanceEditor({ agent, companyId, size = 96 }: AgentAppearanceEditorProps) {
  const queryClient = useQueryClient();
  const appearance = resolveAgentAppearance(agent.appearance, agent.id);
  const update = useMutation({
    mutationFn: (next: AgentAppearance) => agentsApi.update(agent.id, { appearance: next }, companyId ?? undefined),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents", "detail"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) }),
        ...(companyId
          ? [
              queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId), exact: true }),
              queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) }),
            ]
          : []),
      ]);
    },
  });

  return (
    <AgentAppearancePicker value={appearance} agentName={agent.name} onSave={(next) => update.mutateAsync(next)}>
      <button
        type="button"
        aria-label={`Change ${agent.name}'s colour`}
        title="Change colour"
        className="gs-hero-avatar group relative shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <AgentCharacter agent={{ ...agent, appearance }} state={characterStateForAgent(agent.status)} size={size} trackingScope="page" />
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
        >
          <Palette className="size-3.5" />
        </span>
      </button>
    </AgentAppearancePicker>
  );
}
