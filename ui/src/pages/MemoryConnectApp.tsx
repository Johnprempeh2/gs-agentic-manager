import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { MEMORY_CONNECTION_APP_LABEL } from "@greatstone/shared";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError } from "../api/client";
import { memoryGraphApi } from "../api/memoryGraph";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

/** Sends the browser back to the app. Kept apart so tests can watch it. */
export const memoryConnectNavigation = { go: (url: string) => window.location.assign(url) };

/**
 * The Allow screen ChatGPT or Claude.ai opens when someone adds GSAM memory.
 * The server checked the app before sending the person here and checks
 * everything again on Allow; this page only asks.
 */
export function MemoryConnectApp() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params] = useSearchParams();
  const [canContribute, setCanContribute] = useState(false);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? undefined;
  const codeChallenge = params.get("code_challenge") ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory", href: "/memory" }, { label: "Connect an app" }]);
  }, [setBreadcrumbs]);

  const client = useQuery({
    queryKey: ["memory-oauth", "client", clientId, redirectUri],
    queryFn: () => memoryGraphApi.appSignInClient(clientId, redirectUri),
    enabled: !!clientId && !!redirectUri,
    retry: false,
  });
  const approve = useMutation({
    mutationFn: () =>
      memoryGraphApi.approveAppSignIn({
        companyId: selectedCompanyId!,
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: "S256",
        state,
        canContribute,
      }),
    onSuccess: (data) => memoryConnectNavigation.go(data.redirectTo),
  });

  function cancel() {
    // Only back to an address the server confirmed belongs to this app.
    const back = new URL(redirectUri);
    back.searchParams.set("error", "access_denied");
    if (state) back.searchParams.set("state", state);
    memoryConnectNavigation.go(back.toString());
  }

  if (!clientId || !redirectUri || !codeChallenge || client.error) {
    return (
      <div className="mx-auto max-w-lg space-y-2 py-10" data-testid="memory-connect-app">
        <h1 className="text-lg font-semibold">This sign-in link is not valid</h1>
        <p className="text-sm text-muted-foreground">Start the connection again from ChatGPT or Claude.</p>
      </div>
    );
  }
  if (client.isLoading || !client.data) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading...</p>;
  }

  const known = client.data.app !== "other";
  // An unknown app's name is only its own claim, so it is never shown as the heading.
  const appLabel = known ? MEMORY_CONNECTION_APP_LABEL[client.data.app] : "An app";
  const companyName = selectedCompany?.name ?? "your organisation";
  const error = approve.error;
  const refusal =
    error instanceof ApiError && error.status === 403
      ? "An owner has not turned on app sign-in for this organisation's memory. Ask them to turn it on under Memory, Claude and ChatGPT."
      : error instanceof ApiError && error.status === 404
        ? "Memory is not switched on for this organisation."
        : error
          ? "Could not connect. Try again."
          : null;

  return (
    <div className="mx-auto max-w-lg space-y-5 py-10" data-testid="memory-connect-app">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5" />
          Let {appLabel} use {companyName} memory?
        </h1>
        <p className="text-sm text-muted-foreground">
          {appLabel} will be able to search what {companyName} remembers while you chat with it, as you. It cannot see tasks,
          clients or anything else in GSAM.
        </p>
        {known ? <p className="text-sm text-muted-foreground">It will send you back to {client.data.redirectHost}.</p> : null}
      </div>
      {known ? null : (
        <div className="space-y-1 rounded-md border border-destructive p-3 text-sm" role="alert">
          <p className="font-medium text-destructive">This is not ChatGPT or Claude.ai. It sends you back to {client.data.redirectHost}.</p>
          <p className="text-muted-foreground">
            It calls itself "{client.data.name}". Only allow it if you started this from that app yourself and recognise {client.data.redirectHost}.
          </p>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={canContribute} onCheckedChange={(value) => setCanContribute(value === true)} className="mt-0.5" />
        <span>
          Also let it suggest new entries.
          <span className="block text-xs text-muted-foreground">Left off, it can only search. Suggestions wait in Review before anyone relies on them.</span>
        </span>
      </label>
      <p className="text-xs text-muted-foreground">You can cut it off at any time with Disconnect under Memory, Claude and ChatGPT.</p>
      {refusal ? <p className="text-sm text-destructive">{refusal}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={cancel} disabled={approve.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={() => approve.mutate()} disabled={!selectedCompanyId || approve.isPending}>
          {approve.isPending ? "Connecting..." : "Allow"}
        </Button>
      </div>
    </div>
  );
}
