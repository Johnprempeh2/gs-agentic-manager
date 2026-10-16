import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound, X } from "lucide-react";
import type { IntegrationKeyItem, IntegrationKeyState } from "@greatstone/shared";
import { integrationKeysApi } from "@/api/integrationKeys";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useCopyToast } from "@/lib/use-copy-action";

export const integrationKeysKey = (companyId: string) => ["integration-keys", companyId] as const;

const STATE_BADGE: Record<IntegrationKeyState, { status: string; label: string }> = {
  ready: { status: "ok", label: "Key in place" },
  needs_key: { status: "warning", label: "Waiting for a key" },
  sign_in: { status: "unchecked", label: "Needs a sign-in" },
  not_built: { status: "unchecked", label: "Not built yet" },
};

/** Lines to paste into the env file: the variables still missing, with empty values to fill in. */
export function envSnippet(items: IntegrationKeyItem[]) {
  return items
    .filter((item) => item.state === "needs_key")
    .flatMap((item) => [`# ${item.name}`, ...item.variables.filter((variable) => !variable.set).map((variable) => `${variable.name}=`)])
    .join("\n");
}

/**
 * "What needs a key" on Settings > Integrations: every integration waiting on
 * an outside key or sign-in, the exact variable names, whether the server has
 * each one, and where to paste them. Values are never shown.
 */
export function IntegrationKeysPanel({ companyId }: { companyId: string }) {
  const copyToast = useCopyToast();
  const keys = useQuery({
    queryKey: integrationKeysKey(companyId),
    queryFn: () => integrationKeysApi.status(companyId),
  });
  const items = keys.data?.items ?? [];
  const waiting = items.filter((item) => item.state !== "ready").length;
  const snippet = envSnippet(items);

  return (
    <section className="space-y-3 pt-2" aria-labelledby="integration-keys-heading">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 id="integration-keys-heading" className="text-sm font-semibold">What needs a key</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {keys.data
            ? waiting === 0
              ? "Everything here has what it needs."
              : `${waiting} ${waiting === 1 ? "integration is" : "integrations are"} waiting on you. Keys go in the server's env file, then restart GSAM.`
            : "Integrations waiting on an outside key or sign-in."}
        </p>
      </div>
      {keys.error ? (
        <p className="text-sm text-destructive" role="alert">Could not load this list. {(keys.error as Error).message}</p>
      ) : null}
      {keys.data ? (
        <>
          <ul className="grid gap-3 md:grid-cols-2" aria-label="Integrations waiting on a key">
            {items.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid={`integration-key-${item.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{item.name}</h3>
                  <StatusBadge status={STATE_BADGE[item.state].status} label={STATE_BADGE[item.state].label} />
                </div>
                <p className="text-sm text-muted-foreground">{item.unlocks}</p>
                {item.variables.length > 0 ? (
                  <ul className="space-y-1" aria-label={`${item.name} variables`}>
                    {item.variables.map((variable) => (
                      <li key={variable.name} className="flex items-center gap-2 text-xs">
                        {variable.set ? (
                          <Check className="h-3.5 w-3.5 text-muted-foreground" aria-label="Set" />
                        ) : (
                          <X className="h-3.5 w-3.5 text-destructive" aria-label="Missing" />
                        )}
                        <code className="font-mono">{variable.name}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-xs text-muted-foreground">{item.howToGet}</p>
                {item.getKey && item.state !== "ready" ? (
                  <a
                    href={item.getKey.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
                    data-testid={`integration-key-link-${item.id}`}
                  >
                    {item.getKey.label}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
                {item.note ? <p className="text-xs text-muted-foreground">{item.note}</p> : null}
              </li>
            ))}
          </ul>
          {snippet ? (
            <div className="space-y-2 rounded-lg border border-border bg-card p-4">
              <p className="text-sm">
                Paste these into <code className="font-mono text-xs">{keys.data.envFile}</code>, put each key after its
                equals sign, then restart GSAM.
              </p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted p-2 text-xs">{snippet}</pre>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyToast(snippet, "Lines copied")}>
                <Copy />
                Copy lines
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
