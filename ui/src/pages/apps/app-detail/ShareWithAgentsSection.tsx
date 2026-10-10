import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, ConnectionGrant } from "@greatstone/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

/**
 * Lets the owner of a personal GitHub grant share it with agents for work no
 * person caused. Only the grant's own user sees this, so only they can change it.
 */
export function ShareWithAgentsSection({ connectionId, grant, agents }: {
  connectionId: string;
  grant: ConnectionGrant;
  agents: Agent[];
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const delegations = grant.delegations ?? [];
  const mutation = useMutation({
    mutationFn: ({ agentId, share }: { agentId: string; share: boolean }) => {
      const existing = delegations.find((delegation) => delegation.agentId === agentId);
      if (share) return toolsApi.createConnectionGrantDelegation(connectionId, grant.id, agentId);
      return toolsApi.revokeConnectionGrantDelegation(connectionId, grant.id, existing!.id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) }),
  });
  const liveAgents = agents.filter((agent) => agent.status !== "terminated");
  const unshared = liveAgents.filter((agent) => !delegations.some((delegation) => delegation.agentId === agent.id));
  const bulk = useMutation({
    mutationFn: async (share: boolean) => {
      const results = await Promise.allSettled(share
        ? unshared.map((agent) => toolsApi.createConnectionGrantDelegation(connectionId, grant.id, agent.id))
        : delegations.map((delegation) => toolsApi.revokeConnectionGrantDelegation(connectionId, grant.id, delegation.id)));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) throw new Error(`${failed} of ${results.length} agents could not be ${share ? "shared with" : "stopped"}. Try again.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) }),
  });
  const busy = mutation.isPending || bulk.isPending;
  const error = bulk.error ?? mutation.error;
  return <section className="space-y-3" aria-labelledby={`${id}-title`}>
    <div className="space-y-1">
      <h2 id={`${id}-title`} className="text-lg font-semibold">Share with agents</h2>
      <p className="text-sm text-muted-foreground">
        Agents you tick can use your GitHub for work they start themselves. Their commits and pull requests appear as you.
        Work someone asks for still uses that person's own GitHub.
      </p>
    </div>
    {grant.status !== "active"
      ? <p className="text-sm text-muted-foreground">Reconnect your GitHub account to share it.</p>
      : liveAgents.length === 0
        ? <p className="text-sm text-muted-foreground">There are no agents to share with yet.</p>
        : <>
          <div className="flex flex-wrap gap-2">
            {unshared.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk.mutate(true)}>
              {bulk.isPending && bulk.variables ? "Sharing..." : "Share with all agents"}
            </Button>}
            {delegations.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk.mutate(false)}>
              {bulk.isPending && !bulk.variables ? "Stopping..." : "Stop sharing with all"}
            </Button>}
          </div>
          <ul className="space-y-2">
            {liveAgents.map((agent) => {
              const checked = delegations.some((delegation) => delegation.agentId === agent.id);
              return <li key={agent.id} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${agent.id}`}
                  checked={checked}
                  disabled={busy}
                  onCheckedChange={(next) => mutation.mutate({ agentId: agent.id, share: next === true })}
                />
                <label htmlFor={`${id}-${agent.id}`} className="text-sm">{agent.name}</label>
              </li>;
            })}
          </ul>
        </>}
    {error && <p role="alert" className="text-sm text-destructive">
      {error instanceof Error ? error.message : "Sharing could not be updated."}
    </p>}
  </section>;
}
