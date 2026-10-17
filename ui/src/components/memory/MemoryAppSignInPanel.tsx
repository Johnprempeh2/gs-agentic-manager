import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy } from "lucide-react";
import { MEMORY_CONNECTION_APP_LABEL } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useConfirm } from "@/context/ConfirmContext";
import { ApiError } from "../../api/client";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { memoryAppSignInSteps, type MemorySignInApp } from "./memoryConnectionSetup";

const STATUS_KEY = ["memory-oauth", "status"] as const;

/**
 * ChatGPT and Claude.ai connect by signing in to GSAM, not with a pasted key.
 * Shows whether this server offers it, the owner's switch, and the steps.
 */
export function MemoryAppSignInPanel({ companyId, app }: { companyId: string; app: MemorySignInApp }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: () => memoryGraphApi.appSignInStatus(), retry: false });
  const settings = useQuery({
    queryKey: queryKeys.memory.settings(companyId),
    queryFn: () => memoryGraphApi.settings(companyId),
  });
  const toggle = useMutation({
    mutationFn: (appSignIn: boolean) => memoryGraphApi.updateSettings(companyId, { appSignIn }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.memory.settings(companyId), data),
  });
  const label = MEMORY_CONNECTION_APP_LABEL[app];

  if (status.isLoading || settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (status.error || !status.data) {
    return (
      <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="memory-app-sign-in">
        <p>{label} connects by signing in to GSAM, and this GSAM does not offer that sign-in.</p>
        <p className="text-muted-foreground">It needs GSAM's own sign-in and a public address for memory that the app can reach. Until then, use the import above.</p>
      </div>
    );
  }

  const on = settings.data?.appSignIn === true;
  const refused = toggle.error instanceof ApiError && toggle.error.status === 403;
  const steps = memoryAppSignInSteps(app, status.data.mcpUrl);

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="memory-app-sign-in">
      {on ? (
        <>
          <ol className="list-decimal space-y-1 pl-5">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-muted-foreground">
            What {label} adds waits in Review, and Disconnect below cuts it off at once.
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={toggle.isPending} onClick={async () => {
                const ok = await confirm({
                  title: "Turn off app sign-in?",
                  description: "ChatGPT and Claude.ai will no longer be able to connect to memory this way. Apps already connected stay connected until you disconnect them below.",
                  confirmLabel: "Turn off",
                  tone: "destructive",
                });
                if (ok) toggle.mutate(false);
              }}
            >
              Turn off app sign-in
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void copyTextToClipboard(status.data.mcpUrl).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2_000);
                });
              }}
            >
              <ClipboardCopy className="size-4" />
              {copied ? "Copied" : "Copy address"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            {label} connects by signing in to GSAM. App sign-in is off, so no outside app can connect this way yet.
          </p>
          <p className="text-muted-foreground">
            Turning it on lets anyone in the organisation allow ChatGPT or Claude.ai to read and add to memory for themselves.
          </p>
          {refused ? <p className="text-muted-foreground">Only the owner or an admin can turn it on.</p> : null}
          {toggle.error && !refused ? <p className="text-destructive">Could not turn it on. Try again.</p> : null}
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={toggle.isPending || refused} onClick={() => toggle.mutate(true)}>
              {toggle.isPending ? "Turning on..." : "Turn on app sign-in"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
