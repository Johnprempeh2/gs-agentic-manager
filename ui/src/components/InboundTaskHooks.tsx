import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import type { InboundTaskHookSummary, InboundTaskHookWithToken } from "@greatstone/shared";
import { agentsApi } from "@/api/agents";
import { inboundTaskHooksApi } from "@/api/inboundTaskHooks";
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
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCopyToast } from "@/lib/use-copy-action";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";

export const inboundHooksKey = (companyId: string) => ["inbound-task-hooks", companyId] as const;

/** The full URL an outside tool posts to. */
export function hookUrl(hook: Pick<InboundTaskHookSummary, "path">, origin = window.location.origin) {
  return `${origin}${hook.path}`;
}

/** A ready-to-run example, so a person can test the hook or paste it into Zapier. */
export function curlExample(url: string, token: string) {
  return [
    `curl -X POST ${url} \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"title":"New enquiry","description":"From the website form","priority":"medium"}'`,
  ].join("\n");
}

/** One plain line on a hook: how often it was used, and its last problem. */
export function hookStatusLine(hook: InboundTaskHookSummary) {
  if (!hook.enabled) return "Turned off. Requests are refused until you turn it back on.";
  const used = hook.useCount === 0
    ? "Not used yet."
    : `${hook.useCount} ${hook.useCount === 1 ? "task" : "tasks"} created, last ${relativeTime(hook.lastUsedAt!)}.`;
  return hook.lastError && hook.lastErrorAt ? `${used} Last problem ${relativeTime(hook.lastErrorAt)}: ${hook.lastError}` : used;
}

function TokenReveal({ hook, onDone }: { hook: InboundTaskHookWithToken; onDone: () => void }) {
  const url = hookUrl(hook);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    await copyTextToClipboard(text);
    setCopied(label);
  };
  return (
    <div className="space-y-3 text-sm" role="status">
      <p>Copy these now. The token is shown only once; if you lose it, make a new one.</p>
      {[
        ["URL", url],
        ["Token", hook.token],
      ].map(([label, value]) => (
        <div key={label} className="space-y-1">
          <Label>{label}</Label>
          <div className="flex gap-2">
            <Input readOnly value={value} aria-label={label} className="font-mono text-xs" />
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(label!, value!)}>
              <Copy />
              {copied === label ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ))}
      <div className="space-y-1">
        <Label>Try it</Label>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted p-2 text-xs">{curlExample(url, hook.token)}</pre>
        <p className="text-xs text-muted-foreground">
          Send `title` (required), and optionally `description`, `priority` (low, medium, high or critical), `dueDate`
          (YYYY-MM-DD), `externalId` to avoid duplicates, and up to five `files` as name and base64 `data`.
        </p>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Inbound task webhooks on Settings > Integrations: a URL and token other
 * tools post to, to create tasks with files. None exist until a person makes
 * one, and tasks stay unassigned unless the person picks an agent.
 */
export function InboundTaskHooksDialog({ companyId, open, onOpenChange }: { companyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const copyToast = useCopyToast();
  const queryClient = useQueryClient();
  const hooks = useQuery({
    queryKey: inboundHooksKey(companyId),
    queryFn: () => inboundTaskHooksApi.list(companyId),
    enabled: open,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [revealed, setRevealed] = useState<InboundTaskHookWithToken | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: inboundHooksKey(companyId) });

  const create = useMutation({
    mutationFn: () => inboundTaskHooksApi.create(companyId, { name: name.trim(), assigneeAgentId: agentId || null }),
    onSuccess: (hook) => {
      setRevealed(hook);
      setName("");
      setAgentId("");
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => inboundTaskHooksApi.update(companyId, input.id, { enabled: input.enabled }),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: (id: string) => inboundTaskHooksApi.rotate(companyId, id),
    onSuccess: (hook) => {
      setRevealed(hook);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => inboundTaskHooksApi.remove(companyId, id),
    onSuccess: refresh,
  });
  const agentName = (id: string | null) => (id ? agents.data?.find((agent) => agent.id === id)?.name ?? "an agent" : null);
  const error = create.error ?? toggle.error ?? rotate.error ?? remove.error ?? hooks.error;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setRevealed(null); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Webhook for other tools</DialogTitle>
          <DialogDescription>
            Give a form, Zapier or your CRM a private address to send work to. Each request becomes a task, with any files
            attached.
          </DialogDescription>
        </DialogHeader>
        {revealed ? (
          <TokenReveal hook={revealed} onDone={() => setRevealed(null)} />
        ) : (
          <div className="space-y-4 text-sm">
            {(hooks.data ?? []).length > 0 ? (
              <ul className="space-y-2" aria-label="Webhooks">
                {hooks.data!.map((hook) => (
                  <li key={hook.id} className="space-y-1 rounded-md border border-border p-3" data-testid={`inbound-hook-${hook.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{hook.name}</p>
                      <ToggleSwitch
                        checked={hook.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(enabled) => toggle.mutate({ id: hook.id, enabled })}
                        aria-label={`Accept tasks from ${hook.name}`}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {agentName(hook.assigneeAgentId) ? `New tasks go to ${agentName(hook.assigneeAgentId)}.` : "New tasks stay unassigned until someone picks them up."}
                    </p>
                    <p className={hook.lastError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{hookStatusLine(hook)}</p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button type="button" size="sm" variant="outline" onClick={() => void copyToast(hookUrl(hook), "Address copied")}>
                        <Copy />
                        Copy URL
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate(hook.id)}>
                        <KeyRound />
                        New token
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(hook.id)} aria-label={`Delete ${hook.name}`}>
                        <Trash2 />
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : hooks.isLoading ? null : (
              <p className="text-muted-foreground">No webhooks yet.</p>
            )}

            <form
              className="space-y-2 border-t border-border pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <p className="font-medium">Make a new webhook</p>
              <div className="space-y-1">
                <Label htmlFor="inbound-hook-name">Name</Label>
                <Input id="inbound-hook-name" value={name} placeholder="Website enquiry form" onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="inbound-hook-agent">Give new tasks to</Label>
                <NativeSelect id="inbound-hook-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                  <option value="">Nobody yet (I will assign them)</option>
                  {(agents.data ?? []).map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">An agent starts work, and uses its budget, as soon as a task arrives.</p>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={!name.trim() || create.isPending}>
                  {create.isPending ? "Making…" : "Make webhook"}
                </Button>
              </DialogFooter>
            </form>
          </div>
        )}
        {error ? <p className="text-sm text-destructive" role="alert">{(error as Error).message}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
