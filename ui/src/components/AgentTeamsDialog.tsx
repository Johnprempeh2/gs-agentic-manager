import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AGENT_TEAM_COLORS, type Agent, type AgentTeam } from "@greatstone/shared";
import { agentTeamsApi } from "@/api/agentTeams";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

const NO_LEAD = "__none__";

interface TeamDraft {
  id: string | null;
  name: string;
  color: string;
  description: string;
  leadAgentId: string | null;
  memberAgentIds: string[];
}

function draftFrom(team: AgentTeam | null, colorIndex: number): TeamDraft {
  if (!team) {
    return {
      id: null,
      name: "",
      color: AGENT_TEAM_COLORS[colorIndex % AGENT_TEAM_COLORS.length],
      description: "",
      leadAgentId: null,
      memberAgentIds: [],
    };
  }
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    description: team.description ?? "",
    leadAgentId: team.leadAgentId,
    memberAgentIds: team.memberAgentIds,
  };
}

export function TeamColorDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}

/** Create, edit and delete agent teams (GRE-436). Teams never change reporting lines. */
export function AgentTeamsDialog({ companyId, teams, agents, onClose }: {
  companyId: string;
  teams: AgentTeam[];
  agents: Agent[];
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const pickableAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const refresh = () => cache.invalidateQueries({ queryKey: queryKeys.agentTeams.list(companyId) });

  const save = useMutation({
    mutationFn: (value: TeamDraft) => {
      const body = {
        name: value.name.trim(),
        color: value.color,
        description: value.description.trim() || null,
        leadAgentId: value.leadAgentId,
        memberAgentIds: value.memberAgentIds,
      };
      return value.id ? agentTeamsApi.update(value.id, body) : agentTeamsApi.create(companyId, body);
    },
    onSuccess: async () => {
      await refresh();
      setDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => agentTeamsApi.remove(id),
    onSuccess: async () => {
      await refresh();
      setConfirmDeleteId(null);
    },
  });

  function toggleMember(agentId: string, checked: boolean) {
    setDraft((current) => current && {
      ...current,
      memberAgentIds: checked
        ? [...current.memberAgentIds, agentId]
        : current.memberAgentIds.filter((id) => id !== agentId),
      // The lead is always a member, so unticking the lead clears the lead.
      leadAgentId: !checked && current.leadAgentId === agentId ? null : current.leadAgentId,
    });
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent scrollBody className="max-h-(--sz-calc-16) sm:max-w-xl">
      <DialogTitle>{draft ? (draft.id ? "Edit team" : "New team") : "Teams"}</DialogTitle>
      <DialogDescription>
        Group agents by what they work on. An agent can be in more than one team.
        Teams do not change who reports to whom.
      </DialogDescription>

      {draft ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft);
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              value={draft.name}
              maxLength={64}
              autoFocus
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="space-y-1.5 text-sm">
            <span id="team-color-label">Colour</span>
            <div role="radiogroup" aria-labelledby="team-color-label" className="flex flex-wrap gap-2">
              {AGENT_TEAM_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={color}
                  onClick={() => setDraft({ ...draft, color })}
                  className={cn(
                    "h-7 w-7 rounded-full border-2",
                    draft.color === color ? "border-foreground" : "border-transparent",
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          <label className="block space-y-1.5 text-sm">
            <span>Description (optional)</span>
            <Textarea
              value={draft.description}
              maxLength={2000}
              className="min-h-16"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="space-y-1.5 text-sm">
            <span id="team-lead-label">Lead (optional)</span>
            <Select
              value={draft.leadAgentId ?? NO_LEAD}
              onValueChange={(value) => {
                const leadAgentId = value === NO_LEAD ? null : value;
                setDraft({
                  ...draft,
                  leadAgentId,
                  memberAgentIds: leadAgentId && !draft.memberAgentIds.includes(leadAgentId)
                    ? [...draft.memberAgentIds, leadAgentId]
                    : draft.memberAgentIds,
                });
              }}
            >
              <SelectTrigger aria-labelledby="team-lead-label" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LEAD}>No lead</SelectItem>
                {pickableAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-1.5 text-sm">
            <legend>Members</legend>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {pickableAgents.map((agent) => (
                <label key={agent.id} className="flex min-h-9 items-center gap-2">
                  <Checkbox
                    checked={draft.memberAgentIds.includes(agent.id)}
                    onCheckedChange={(checked) => toggleMember(agent.id, checked === true)}
                  />
                  <span className="truncate">{agent.name}</span>
                  {draft.leadAgentId === agent.id && <span className="text-xs text-muted-foreground">Lead</span>}
                </label>
              ))}
            </div>
          </fieldset>
          {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          <div className="flex justify-between gap-4">
            <Button type="button" variant="ghost" onClick={() => { save.reset(); setDraft(null); }}>Back</Button>
            <Button type="submit" disabled={save.isPending || draft.name.trim().length === 0}>
              {save.isPending ? "Saving…" : draft.id ? "Save team" : "Create team"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">No teams yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {teams.map((team) => (
                <li key={team.id} className="flex flex-wrap items-center gap-3 p-3">
                  <TeamColorDot color={team.color} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{team.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {team.memberAgentIds.length} member{team.memberAgentIds.length === 1 ? "" : "s"}
                      {team.leadAgentId && agentName.has(team.leadAgentId) ? ` · Lead: ${agentName.get(team.leadAgentId)}` : ""}
                    </p>
                  </div>
                  {confirmDeleteId === team.id ? (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(team.id)}>
                        {remove.isPending ? "Deleting…" : "Delete"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDraft(draftFrom(team, 0))}>Edit</Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${team.name}`} onClick={() => { remove.reset(); setConfirmDeleteId(team.id); }}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {remove.error && <p role="alert" className="text-sm text-destructive">{remove.error.message}</p>}
          <div className="flex justify-between gap-4">
            <Button variant="ghost" onClick={onClose}>Done</Button>
            <Button onClick={() => { save.reset(); setDraft(draftFrom(null, teams.length)); }}>New team</Button>
          </div>
        </div>
      )}
    </DialogContent>
  </Dialog>;
}
