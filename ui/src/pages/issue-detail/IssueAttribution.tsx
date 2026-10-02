import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentIdentity } from "@/components/AgentIdentity";
import { formatUserLabel } from "../../lib/assignees";
import { Identity } from "../../components/Identity";
import { Avatar, AvatarImage, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { type ActivityEvent, type Agent, type Issue, deriveOriginatingActor } from "@greatstone/shared";

export function ActorIdentity({
  evt,
  agentMap,
  userProfileMap,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<
    string,
    import("../../lib/company-members").CompanyUserProfile
  >;
}) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <AgentIdentity agent={agent ?? { id, name: id.slice(0, 8) }} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") {
    const profile = userProfileMap?.get(id);
    return (
      <Identity
        name={profile?.label ?? "Board"}
        avatarUrl={profile?.image}
        size="sm"
      />
    );
  }
  return <Identity name={id || "Unknown"} size="sm" />;
}

export type AttributionActor = {
  appearance?: Agent["appearance"];
  kind: "agent" | "user";
  id: string;
  name: string;
  avatarUrl?: string | null;
};

function attributionInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function AttributionAvatar({
  label,
  actor,
  via,
}: {
  label: "Assignee" | "Originating";
  actor: AttributionActor;
  via?: string | null;
}) {
  const accessibleLabel = via
    ? `${label}: ${actor.name} · via ${via}`
    : `${label}: ${actor.name}`;
  const testIdLabel = label.toLowerCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={accessibleLabel} data-testid={`issue-${testIdLabel}-avatar`}>
          {actor.kind === "agent" ? <AgentAvatar agent={actor} size={20} /> : (
            <Avatar size="xs" className="ring-2 ring-background">
              {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
              <AvatarFallback>{attributionInitials(actor.name)}</AvatarFallback>
            </Avatar>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1.5">
        <div
          className="flex items-center gap-2"
          data-testid={`issue-${testIdLabel}-tooltip`}
        >
          {actor.kind === "agent" ? <AgentAvatar agent={actor} size={32} /> : (
            <Avatar size="sm" className="ring-1 ring-background/30">
              {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
              <AvatarFallback>{attributionInitials(actor.name)}</AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0">
            <div className="text-(length:--text-nano) font-medium uppercase leading-none text-background/70">
              {label}
            </div>
            <div className="max-w-48 truncate text-xs font-medium leading-4 text-background">
              {actor.name}
            </div>
            {via ? (
              <div className="max-w-48 truncate text-(length:--text-nano) leading-3 text-background/60">
                via {via}
              </div>
            ) : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function IssueAttributionByline({
  issue,
  agentMap,
  userProfileMap,
  userLabelMap,
}: {
  issue: Issue;
  agentMap: Map<string, Agent>;
  userProfileMap: ReadonlyMap<
    string,
    import("../../lib/company-members").CompanyUserProfile
  >;
  userLabelMap: ReadonlyMap<string, string>;
}) {
  const assignee: AttributionActor | null = issue.assigneeAgentId
    ? {
        kind: "agent",
        id: issue.assigneeAgentId,
        appearance: agentMap.get(issue.assigneeAgentId)?.appearance,
        name:
          agentMap.get(issue.assigneeAgentId)?.name ??
          issue.assigneeAgentId.slice(0, 8),
      }
    : issue.assigneeUserId
      ? {
          kind: "user",
          id: issue.assigneeUserId,
          name:
            formatUserLabel(issue.assigneeUserId, userLabelMap) ??
            userProfileMap.get(issue.assigneeUserId)?.label ??
            "User",
          avatarUrl: userProfileMap.get(issue.assigneeUserId)?.image ?? null,
        }
      : null;
  const originatingActor = deriveOriginatingActor(issue);
  const originator: AttributionActor | null = originatingActor
    ? originatingActor.kind === "agent"
      ? {
          kind: "agent",
          id: originatingActor.id,
          appearance: agentMap.get(originatingActor.id)?.appearance,
          name:
            agentMap.get(originatingActor.id)?.name ??
            originatingActor.id.slice(0, 8),
        }
      : {
          kind: "user",
          id: originatingActor.id,
          name:
            formatUserLabel(originatingActor.id, userLabelMap) ??
            userProfileMap.get(originatingActor.id)?.label ??
            "User",
          avatarUrl: userProfileMap.get(originatingActor.id)?.image ?? null,
        }
    : null;
  const originatorVia =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? (agentMap.get(originatingActor.viaAgentId)?.name ??
        originatingActor.viaAgentId.slice(0, 8))
      : null;
  if (!assignee && !originator) return null;

  return (
    <TooltipProvider>
      <AvatarGroup
        className="-space-x-1.5"
        aria-label="Task people"
        data-testid="issue-attribution-avatar-stack"
      >
        {assignee ? (
          <AttributionAvatar label="Assignee" actor={assignee} />
        ) : null}
        {originator ? (
          <AttributionAvatar
            label="Originating"
            actor={originator}
            via={originatorVia}
          />
        ) : null}
      </AvatarGroup>
    </TooltipProvider>
  );
}
