import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Link2 } from "lucide-react";
import {
  MEMORY_CONNECTION_APP_LABEL,
  type CreatedMemoryConnection,
  type MemoryConnectionApp,
} from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { copyTextToClipboard } from "@/lib/clipboard";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { formatDate } from "@/lib/utils";
import { accessApi } from "../../api/access";
import { ApiError } from "../../api/client";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryConnectionCheck, MemoryConnectionHistory } from "./MemoryConnectionActivity";
import { memoryConnectionSetup, memoryMcpUrl } from "./memoryConnectionSetup";

const APP_OPTIONS: Array<{ value: MemoryConnectionApp; description: string }> = [
  { value: "claude", description: "The Claude app on a Mac or PC" },
  { value: "claude_code", description: "Claude in a terminal" },
  { value: "codex", description: "OpenAI's coding agent" },
  { value: "chatgpt", description: "Not possible yet, see below" },
  { value: "other", description: "Any app that speaks MCP" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void copyTextToClipboard(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2_000);
        });
      }}
    >
      <ClipboardCopy className="size-4" />
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Live links so Claude, Claude Code or Codex can search and add to memory in
 * the middle of a chat. Each person connects their own apps; owners and admins
 * also see everyone's. The server says who may.
 */
export function MemoryConnectionsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [app, setApp] = useState<MemoryConnectionApp>("claude");
  const [canContribute, setCanContribute] = useState(true);
  const [created, setCreated] = useState<CreatedMemoryConnection | null>(null);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: queryKeys.memoryGraph.connections(companyId),
    queryFn: () => memoryGraphApi.connections(companyId),
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 2,
  });
  // An owner or admin sees everyone's connections, so each row names who made it.
  const userDirectory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: (connections.data ?? []).length > 0,
  });
  const ownerLabels = buildCompanyUserLabelMap(userDirectory.data?.users);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.memoryGraph.connections(companyId) });

  const create = useMutation({
    mutationFn: () => memoryGraphApi.createConnection(companyId, { app, canContribute }),
    onSuccess: (data) => {
      setCreated(data);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (agentId: string) => memoryGraphApi.revokeConnection(companyId, agentId),
    onSuccess: (_data, agentId) => {
      if (created?.connection.agentId === agentId) setCreated(null);
      refresh();
    },
  });

  const forbidden = connections.error instanceof ApiError && connections.error.status === 403;
  const url = memoryMcpUrl(window.location.origin);
  const setup = memoryConnectionSetup(created?.connection.app ?? app, url, created?.token ?? "YOUR-KEY");
  const chosenSetup = memoryConnectionSetup(app, url, "YOUR-KEY");

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label="Use memory from inside Claude">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Link2 className="size-4" />
          Use memory from inside Claude
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect an app once and it can look things up in shared memory while you chat, and suggest new entries. What it adds
          is labelled with the app's name and waits in Review like everything else.
        </p>
      </div>

      {forbidden ? (
        <p className="text-sm text-muted-foreground">Only a person signed in to GSAM can connect an app.</p>
      ) : (
        <>
          <RadioCardGroup
            ariaLabel="App to connect"
            value={app}
            onValueChange={(value) => {
              setApp(value as MemoryConnectionApp);
              setCreated(null);
            }}
            options={APP_OPTIONS.map((option) => ({
              value: option.value,
              title: MEMORY_CONNECTION_APP_LABEL[option.value],
              description: option.description,
            }))}
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
          />

          {chosenSetup.snippet === null ? (
            <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm">
              {chosenSetup.steps.map((step) => (
                <p key={step}>{step}</p>
              ))}
            </div>
          ) : created ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Connection ready. Copy this now: the key is shown only once.</p>
              <ol className="list-decimal space-y-1 pl-5">
                {setup.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">{setup.snippet}</pre>
              <MemoryConnectionCheck
                companyId={companyId}
                agentId={created.connection.agentId}
                appLabel={MEMORY_CONNECTION_APP_LABEL[created.connection.app]}
              />
              <div className="flex items-center justify-between gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  Done
                </Button>
                <CopyButton text={setup.snippet ?? ""} label="Copy setup" />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={canContribute} onCheckedChange={(value) => setCanContribute(value === true)} className="mt-0.5" />
                <span>
                  Let it suggest new entries for shared memory.
                  <span className="block text-xs text-muted-foreground">Left off, it can only read shared memory and keep its own notes.</span>
                </span>
              </label>
              {create.error ? (
                <p className="text-sm text-destructive">{create.error instanceof Error ? create.error.message : "Could not connect. Try again."}</p>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
                  {create.isPending ? "Connecting..." : `Connect ${MEMORY_CONNECTION_APP_LABEL[app]}`}
                </Button>
              </div>
            </div>
          )}

          {(connections.data ?? []).length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Connected apps</h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {(connections.data ?? []).map((connection) => {
                  const lastUsed = connection.keys
                    .map((key) => key.lastUsedAt)
                    .filter((value): value is string => typeof value === "string")
                    .sort()
                    .at(-1);
                  const owner = connection.createdByUserId ? ownerLabels.get(connection.createdByUserId) : undefined;
                  return (
                    <li key={connection.agentId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">{MEMORY_CONNECTION_APP_LABEL[connection.app]}</p>
                        <p className="text-xs text-muted-foreground">{owner ? `Connected by ${owner}` : "Owner unknown"}</p>
                        <p className="text-xs text-muted-foreground">
                          {connection.canContribute ? "Reads and suggests entries" : "Reads only"}
                          {", "}
                          {lastUsed ? `last used ${formatDate(lastUsed)}` : "not used yet"}
                          {connection.keys.length > 1 ? `, ${connection.keys.length} keys` : ""}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-expanded={openHistory === connection.agentId}
                          onClick={() => setOpenHistory(openHistory === connection.agentId ? null : connection.agentId)}
                        >
                          {openHistory === connection.agentId ? "Hide activity" : "What it has done"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(connection.agentId)}
                        >
                          Disconnect
                        </Button>
                      </div>
                      {openHistory === connection.agentId ? (
                        <div className="w-full">
                          <MemoryConnectionHistory companyId={companyId} agentId={connection.agentId} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {connections.error && !forbidden ? (
            <p className="text-sm text-destructive">Could not load connected apps.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
