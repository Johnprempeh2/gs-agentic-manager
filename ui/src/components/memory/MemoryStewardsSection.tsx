import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accessApi } from "../../api/access";
import type { MemoryScopeSteward } from "@greatstone/shared";
import { memoryReviewApi } from "../../api/memoryReview";
import { queryKeys } from "../../lib/queryKeys";
import { actionErrorText } from "../../lib/memory-review";
import { scopeKindLabel } from "./memoryLabels";

const NONE = "none";

/**
 * A named steward and a backup per scope (deck v7 slide 19). Owner or admin
 * sets them; client and restricted scopes, and pricing, policy and legal,
 * stay with the owner.
 */
export function MemoryStewardsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const stewards = useQuery({
    queryKey: queryKeys.memoryReview.stewards(companyId),
    queryFn: () => memoryReviewApi.stewards(companyId),
  });
  const members = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
  });
  const people = useMemo(
    () =>
      (members.data?.members ?? [])
        .filter((member) => member.status === "active" && member.user)
        .map((member) => ({ id: member.principalId, name: member.user?.name || member.user?.email || "Board member" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members.data],
  );
  const canEdit = members.data?.access.canManageMembers ?? false;
  const nameOf = (userId: string | null) => (userId ? people.find((person) => person.id === userId)?.name ?? "Board member" : "Not set");

  const save = useMutation({
    mutationFn: (row: Pick<MemoryScopeSteward, "scopeId" | "primaryUserId" | "backupUserId">) =>
      memoryReviewApi.setSteward(companyId, row.scopeId, { primaryUserId: row.primaryUserId, backupUserId: row.backupUserId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryReview.stewards(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryReview.all(companyId) });
    },
  });

  if (stewards.isLoading || stewards.error) return null;
  const rows = stewards.data?.scopes ?? [];

  const picker = (row: MemoryScopeSteward, field: "primaryUserId" | "backupUserId", label: string) => {
    if (!canEdit || row.ownerOnly) return <span className="text-sm">{nameOf(row[field])}</span>;
    return (
      <Select
        value={row[field] ?? NONE}
        onValueChange={(value) => save.mutate({ ...row, [field]: value === NONE ? null : value })}
        disabled={save.isPending}
      >
        <SelectTrigger className="h-8 w-full sm:w-44" aria-label={`${label} for ${row.scopeName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not set</SelectItem>
          {people.map((person) => (
            <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  return (
    <section className="rounded-lg border border-border bg-card" aria-labelledby="memory-stewards-heading">
      <div className="space-y-0.5 border-b border-border px-3 py-2">
        <h2 id="memory-stewards-heading" className="text-sm font-semibold">Stewards</h2>
        <p className="text-xs text-muted-foreground">
          One person confirms cards in each scope, with a backup. The owner keeps pricing, policy, legal and client.
        </p>
      </div>
      {save.error ? (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">{actionErrorText(save.error)}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No scopes yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.scopeId} className="grid gap-2 px-3 py-2.5 sm:grid-cols-3 sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.scopeName}</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  {scopeKindLabel[row.scopeKind]}
                  {row.ownerOnly ? (
                    <>
                      <Lock className="h-3 w-3" aria-hidden="true" /> Owner only
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex items-center gap-2 sm:block">
                <span className="w-16 shrink-0 text-xs text-muted-foreground sm:hidden">Steward</span>
                {picker(row, "primaryUserId", "Steward")}
              </div>
              <div className="flex items-center gap-2 sm:block">
                <span className="w-16 shrink-0 text-xs text-muted-foreground sm:hidden">Backup</span>
                {picker(row, "backupUserId", "Backup steward")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
