import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryGrantablePermission } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { memoryGraphApi } from "@/api/memoryGraph";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useMemoryEnabled } from "@/hooks/useMemoryEnabled";
import { queryKeys } from "@/lib/queryKeys";

type Grant = { permissionKey: string; scope?: unknown };

const RIGHTS: Array<{ permission: MemoryGrantablePermission; label: string; hint: string; scopedHint: string }> = [
  {
    permission: "memory:contribute",
    label: "Can contribute to organisation memory",
    hint: "Lets this agent propose facts to organisation and project memory. Never covers client or restricted memory.",
    scopedHint: "This agent has a contribute grant with its own scope settings, so this toggle is locked.",
  },
  {
    permission: "memory:approve",
    label: "Can approve organisation memory (operational)",
    hint: "Lets this agent approve operational facts in organisation memory. Pricing, policy, legal and client commitments stay with the owner.",
    scopedHint: "This agent has an approve grant with its own scope settings, so this toggle is locked.",
  },
];

/**
 * Organisation memory rights on the agent Permissions tab (GRE-988). They are
 * written only through the owner grant service (PATCH /memory/grants), so the
 * toggles are hidden while memory is off and locked for anyone who is not a
 * company owner or admin. The server stays authoritative and answers 403.
 */
export function AgentMemoryRightsToggles({
  companyId,
  agentId,
  grants,
  onChanged,
  onError,
}: {
  companyId: string | null | undefined;
  agentId: string;
  grants: Grant[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { enabled: memoryEnabled } = useMemoryEnabled(companyId);
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    enabled: memoryEnabled,
  });
  const membership = boardAccess.data?.memberships?.find((m) => m.companyId === companyId);
  const canGrant =
    boardAccess.data?.source === "local_implicit" ||
    Boolean(boardAccess.data?.isInstanceAdmin) ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin";

  const change = useMutation({
    mutationFn: (input: { permission: MemoryGrantablePermission; enabled: boolean }) =>
      memoryGraphApi.changeGrant(companyId!, {
        principalType: "agent",
        principalId: agentId,
        ...input,
        reason: "Changed on the agent Permissions tab",
      }),
    onSuccess: () => {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["memory", companyId ?? ""] });
    },
    onError: (err) => onError(err instanceof Error ? err.message : "Could not change memory rights"),
  });

  if (!memoryEnabled || !companyId) return null;

  return (
    <>
      {RIGHTS.map(({ permission, label, hint, scopedHint }) => {
        const checked = grants.some((grant) => grant.permissionKey === permission && !grant.scope);
        const scoped = grants.some((grant) => grant.permissionKey === permission && Boolean(grant.scope));
        return (
          <div key={permission} className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>{label}</div>
              <p className="text-xs text-muted-foreground">
                {scoped ? scopedHint : canGrant ? hint : `${hint} Only a company owner or admin can change this.`}
              </p>
            </div>
            <ToggleSwitch
              checked={checked}
              aria-label={label}
              onCheckedChange={() => change.mutate({ permission, enabled: !checked })}
              disabled={!canGrant || scoped || change.isPending}
            />
          </div>
        );
      })}
    </>
  );
}
