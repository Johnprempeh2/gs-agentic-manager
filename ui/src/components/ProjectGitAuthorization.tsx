import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { accessApi } from "@/api/access";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { ErrorState } from "./ErrorState";

export function ProjectGitAuthorization({ companyId, projectId }: { companyId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [draftGrantId, setDraftGrantId] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const userId = access.data?.userId ?? null;
  const membership = access.data?.memberships?.find((entry) => entry.companyId === companyId);
  const canWrite = Boolean(userId && (
    access.data?.source === "local_implicit" ||
    (membership?.status === "active" && membership.membershipRole !== "viewer")
  ));
  const authorizationKey = ["projects", "git-authorization", companyId, projectId, userId] as const;
  const authorization = useQuery({
    queryKey: authorizationKey,
    queryFn: () => projectsApi.gitAuthorization(projectId, companyId),
    enabled: canWrite,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (grantId: string | null) => projectsApi.setGitAuthorization(projectId, companyId, grantId),
    onSuccess: (saved) => {
      queryClient.setQueryData(authorizationKey, saved);
      setDraftGrantId(null);
      setConsentChecked(false);
      setSaveError(null);
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : "Try again.");
    },
  });

  const selected = authorization.data?.grantId ?? null;
  const selectedOption = authorization.data?.options.find((option) => option.grantId === selected);
  const selectedByMe = selected !== null && authorization.data?.authorizedByUserId === userId;
  const choice = draftGrantId ?? (selectedByMe && selectedOption ? selected : "");

  return <section aria-label="Background Git access" className="space-y-3 border-t border-border pt-6">
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">Background Git access</h2>
      <p className="text-sm text-muted-foreground">
        Choose a personal GitHub Connector grant for this project. When private repository access is needed,
        managed workspace clone, base ref fetch and preview update use the selected grant. Access is checked for each operation.
      </p>
    </div>

    {access.isPending ? <p role="status" className="text-sm text-muted-foreground">Checking project access…</p>
      : access.isError ? <ErrorState compact title="Project access did not load" error={access.error} onRetry={() => void access.refetch()} retrying={access.isFetching} />
      : !canWrite ? <p className="text-sm text-muted-foreground">Sign in as a project writer to manage background Git access.</p>
      : authorization.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading GitHub grants…</p>
      : authorization.isError ? <ErrorState compact title="GitHub grants did not load" error={authorization.error} onRetry={() => void authorization.refetch()} retrying={authorization.isFetching} />
      : authorization.data ? <>
        <div role="status" className="text-sm">
          {selected === null ? <p>No grant selected. Private background Git cannot use a credential.</p>
            : selectedByMe && selectedOption ? <p>Your consent is recorded for {selectedOption.connectionName} ({selectedOption.login}). The grant is checked before each use.</p>
            : selectedByMe ? <p>Your selected grant is no longer in your eligible options. Private background Git cannot use it. Choose another grant or revoke it.</p>
            : <p>A grant selected by another writer is recorded. It is not in your personal options, and its current access cannot be confirmed here. Choose your own grant or revoke it.</p>}
        </div>
        {authorization.data.options.length === 0 ? <p className="text-sm text-muted-foreground">
          No eligible personal GitHub grants. <Link to="/apps" className="text-primary underline underline-offset-4">Connect GitHub in Apps</Link>,
          then make your personal Connector grant available to this company. Return here and try again.
        </p> : <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor={`project-git-grant-${projectId}`} className="text-sm font-medium">Your GitHub grant</label>
            <select id={`project-git-grant-${projectId}`} className="flex h-9 w-full rounded-md border border-input bg-field px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={choice ?? ""}
              disabled={save.isPending} onChange={(event) => { setDraftGrantId(event.target.value); setConsentChecked(false); setSaveError(null); }}>
              <option value="">Choose a personal grant</option>
              {authorization.data.options.map((option) => <option key={option.grantId} value={option.grantId}>{option.connectionName} ({option.login})</option>)}
            </select>
          </div>
          {choice && choice !== selected && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-primary" checked={consentChecked} disabled={save.isPending}
              onChange={(event) => setConsentChecked(event.target.checked)} />
            <span>I allow this project to use the selected personal GitHub grant for background Git on its private repository.</span>
          </label>}
          <Button type="button" disabled={!choice || choice === selected || !consentChecked || save.isPending}
            onClick={() => { setSaveError(null); save.mutate(choice); }}>
            {save.isPending && save.variables !== null ? "Saving consent…" : "Allow background Git"}
          </Button>
        </div>}
        {selected !== null && <Button type="button" variant="outline" disabled={save.isPending}
          onClick={() => { setSaveError(null); save.mutate(null); }}>
          {save.isPending && save.variables === null ? "Revoking…" : "Revoke project grant"}
        </Button>}
        {saveError && <p role="alert" className="text-sm text-destructive">Consent was not changed. {saveError} Try again.</p>}
      </> : null}
  </section>;
}
