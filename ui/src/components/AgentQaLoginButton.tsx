import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorCheck } from "lucide-react";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { agentQaLoginsApi } from "@/api/agentQaLogins";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { queryKeys } from "@/lib/queryKeys";

/** Client mirror of the route guard: board owners only. The server stays authoritative. */
export function canGiveQaLogin(companyId: string, access: CurrentBoardAccess | undefined) {
  if (!access) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  const membership = access.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return membership?.membershipRole === "owner";
}

function formatExpiry(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * "Give browser QA access" on an agent's page (GRE-2387). A board owner picks
 * Viewer or Operator and an expiry; the server makes the agent's own log-in.
 * Nobody sees or types a password. While access is live, the button shows the
 * expiry and "Revoke now".
 */
export function AgentQaLoginButton({ agentId, agentName, companyId }: { agentId: string; agentName: string; companyId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"viewer" | "operator">("viewer");
  const [days, setDays] = useState("7");
  const [error, setError] = useState<string | null>(null);

  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isOwner = canGiveQaLogin(companyId, access.data);
  const current = useQuery({
    queryKey: queryKeys.agents.qaLogin(agentId),
    queryFn: () => agentQaLoginsApi.get(agentId),
    enabled: isOwner,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.qaLogin(agentId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(companyId) });
  };
  const grant = useMutation({
    mutationFn: () => agentQaLoginsApi.grant(agentId, { role, expiresInDays: Number(days) }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not give access."),
  });
  const revoke = useMutation({
    mutationFn: () => agentQaLoginsApi.revoke(agentId),
    onSuccess: refresh,
  });

  if (!isOwner) return null;
  const qaLogin = current.data?.qaLogin ?? null;

  if (qaLogin) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" title={qaLogin.email}>
          Browser QA ({qaLogin.role === "operator" ? "Operator" : "Viewer"}) until {formatExpiry(qaLogin.expiresAt)}
        </span>
        <Button size="sm" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
          Revoke now
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={current.isLoading}>
        <MonitorCheck />
        Give browser QA access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Give {agentName} browser QA access</DialogTitle>
            <DialogDescription>
              {agentName} gets its own member log-in, shown in Members as "QA for {agentName}". It has no password. It cannot
              approve cards, publish or move money. It stops at the expiry, or when you revoke it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="qa-login-role">Role</Label>
              <NativeSelect id="qa-login-role" value={role} onChange={(event) => setRole(event.target.value as "viewer" | "operator")}>
                <option value="viewer">Viewer: can look, cannot change</option>
                <option value="operator">Operator: can do ordinary work</option>
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="qa-login-days">Expires after (days)</Label>
              <Input id="qa-login-days" type="number" min={1} max={30} value={days} onChange={(event) => setDays(event.target.value)} />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => grant.mutate()} disabled={grant.isPending}>
              Give access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
