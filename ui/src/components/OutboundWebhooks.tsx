import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ScrollText, Send, Trash2 } from "lucide-react";
import {
  OUTBOUND_WEBHOOK_EVENT_LABELS,
  OUTBOUND_WEBHOOK_EVENTS,
  type OutboundWebhookDelivery,
  type OutboundWebhookEvent,
  type OutboundWebhookSummary,
  type OutboundWebhookWithSecret,
} from "@greatstone/shared";
import { outboundWebhooksApi } from "@/api/outboundWebhooks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useCopyToast } from "@/lib/use-copy-action";
import { relativeTime } from "@/lib/utils";

export const outboundWebhooksKey = (companyId: string) => ["outbound-webhooks", companyId] as const;
const deliveriesKey = (companyId: string, id: string) => ["outbound-webhooks", companyId, id, "deliveries"] as const;

const DEFAULT_EVENTS: OutboundWebhookEvent[] = ["task.done", "decision.needed", "client.stage_changed"];

/** The events a webhook receives, in words. */
export function eventsInWords(events: OutboundWebhookEvent[]) {
  return events.map((event) => OUTBOUND_WEBHOOK_EVENT_LABELS[event].toLowerCase()).join(", ");
}

/** One plain line on a webhook: off, not sent yet, last sent, or its last problem. */
export function outboundStatusLine(webhook: OutboundWebhookSummary) {
  if (!webhook.enabled) return "Turned off. Nothing is sent until you turn it back on.";
  if (!webhook.lastDeliveryAt) return "Nothing sent yet.";
  if (webhook.lastDeliveryOk === false) return `Last send failed ${relativeTime(webhook.lastDeliveryAt)}: ${webhook.lastError ?? "no answer"}`;
  return `Last sent ${relativeTime(webhook.lastDeliveryAt)}.`;
}

function deliveryLine(delivery: OutboundWebhookDelivery) {
  const what = delivery.event === "test" ? "Test" : OUTBOUND_WEBHOOK_EVENT_LABELS[delivery.event];
  const result = delivery.ok ? "Sent." : `Failed${delivery.error ? `: ${delivery.error}` : "."}`;
  return `${what}: ${delivery.summary}. ${result}`;
}

function DeliveryLog({ companyId, webhookId }: { companyId: string; webhookId: string }) {
  const log = useQuery({
    queryKey: deliveriesKey(companyId, webhookId),
    queryFn: () => outboundWebhooksApi.deliveries(companyId, webhookId),
  });
  if (log.error) return <p className="text-xs text-destructive" role="alert">{(log.error as Error).message}</p>;
  if (log.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (!log.data?.length) return <p className="text-xs text-muted-foreground">Nothing sent yet.</p>;
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs" aria-label="Delivery log">
      {log.data.map((delivery) => (
        <li key={delivery.id} className={delivery.ok ? "text-muted-foreground" : "text-destructive"}>
          <span className="font-medium">{relativeTime(delivery.createdAt)}</span> {deliveryLine(delivery)}
        </li>
      ))}
    </ul>
  );
}

function SecretReveal({ webhook, onDone }: { webhook: OutboundWebhookWithSecret; onDone: () => void }) {
  const copyToast = useCopyToast();
  return (
    <div className="space-y-3 text-sm" role="status">
      <p>
        {webhook.name} is ready. Use Send test to check it. If the receiving tool checks signatures, give it this signing
        secret now; it is shown only once.
      </p>
      <div className="space-y-1">
        <Label>Signing secret</Label>
        <div className="flex gap-2">
          <Input readOnly value={webhook.signingSecret} aria-label="Signing secret" className="font-mono text-xs" />
          <Button type="button" size="sm" variant="outline" onClick={() => void copyToast(webhook.signingSecret, "Secret copied")}>
            <Copy />
            Copy
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Each request carries `X-GSAM-Signature: sha256=…`, an HMAC of the `X-GSAM-Timestamp` value, a dot and the body.
          Slack and Teams ignore it.
        </p>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Outbound webhooks on Settings > Integrations: GSAM posts to a pasted address
 * when chosen events happen. None exist until a person adds one.
 */
export function OutboundWebhooksDialog({ companyId, open, onOpenChange }: { companyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const webhooks = useQuery({
    queryKey: outboundWebhooksKey(companyId),
    queryFn: () => outboundWebhooksApi.list(companyId),
    enabled: open,
  });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<OutboundWebhookEvent[]>(DEFAULT_EVENTS);
  const [revealed, setRevealed] = useState<OutboundWebhookWithSecret | null>(null);
  const [logOpen, setLogOpen] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; delivery: OutboundWebhookDelivery } | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: outboundWebhooksKey(companyId) });

  const create = useMutation({
    mutationFn: () => outboundWebhooksApi.create(companyId, { name: name.trim(), url: url.trim(), events }),
    onSuccess: (webhook) => {
      setRevealed(webhook);
      setName("");
      setUrl("");
      setEvents(DEFAULT_EVENTS);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => outboundWebhooksApi.update(companyId, input.id, { enabled: input.enabled }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (id: string) => outboundWebhooksApi.test(companyId, id),
    onSuccess: (delivery, id) => {
      setTestResult({ id, delivery });
      refresh();
      void queryClient.invalidateQueries({ queryKey: deliveriesKey(companyId, id) });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => outboundWebhooksApi.remove(companyId, id),
    onSuccess: refresh,
  });
  const error = create.error ?? toggle.error ?? test.error ?? remove.error ?? webhooks.error;
  const toggleEvent = (event: OutboundWebhookEvent, checked: boolean) =>
    setEvents((current) => (checked ? [...new Set([...current, event])] : current.filter((item) => item !== event)));
  const canCreate = name.trim() && url.trim().startsWith("https://") && events.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setRevealed(null); setTestResult(null); } onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send updates to other tools</DialogTitle>
          <DialogDescription>
            Paste an address from Slack, Teams, Zapier or Make. When something you pick happens, GSAM posts a short message
            and the details there.
          </DialogDescription>
        </DialogHeader>
        {revealed ? (
          <SecretReveal webhook={revealed} onDone={() => setRevealed(null)} />
        ) : (
          <div className="space-y-4 text-sm">
            {(webhooks.data ?? []).length > 0 ? (
              <ul className="space-y-2" aria-label="Outbound webhooks">
                {webhooks.data!.map((webhook) => (
                  <li key={webhook.id} className="space-y-1 rounded-md border border-border p-3" data-testid={`outbound-webhook-${webhook.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{webhook.name}</p>
                      <ToggleSwitch
                        checked={webhook.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(enabled) => toggle.mutate({ id: webhook.id, enabled })}
                        aria-label={`Send updates to ${webhook.name}`}
                      />
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">{webhook.maskedUrl}</p>
                    <p className="text-xs text-muted-foreground">Sends when: {eventsInWords(webhook.events)}.</p>
                    <p className={webhook.lastDeliveryOk === false && webhook.enabled ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      {outboundStatusLine(webhook)}
                    </p>
                    {testResult?.id === webhook.id ? (
                      <p className={testResult.delivery.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} role="status">
                        {testResult.delivery.ok ? "Test sent. Check it arrived." : `Test failed: ${testResult.delivery.error ?? "no answer"}`}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button type="button" size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate(webhook.id)}>
                        <Send />
                        {test.isPending && test.variables === webhook.id ? "Sending…" : "Send test"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={logOpen === webhook.id}
                        onClick={() => setLogOpen(logOpen === webhook.id ? null : webhook.id)}
                      >
                        <ScrollText />
                        Delivery log
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(webhook.id)} aria-label={`Delete ${webhook.name}`}>
                        <Trash2 />
                        Delete
                      </Button>
                    </div>
                    {logOpen === webhook.id ? <DeliveryLog companyId={companyId} webhookId={webhook.id} /> : null}
                  </li>
                ))}
              </ul>
            ) : webhooks.isLoading ? null : (
              <p className="text-muted-foreground">No addresses yet.</p>
            )}

            <form
              className="space-y-2 border-t border-border pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (canCreate) create.mutate();
              }}
            >
              <p className="font-medium">Add an address</p>
              <div className="space-y-1">
                <Label htmlFor="outbound-webhook-name">Name</Label>
                <Input id="outbound-webhook-name" value={name} placeholder="Slack #client-updates" onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="outbound-webhook-url">Address</Label>
                <Input
                  id="outbound-webhook-url"
                  value={url}
                  placeholder="https://hooks.slack.com/services/…"
                  onChange={(event) => setUrl(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">In Slack or Teams, add an incoming webhook to a channel and copy its address.</p>
              </div>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Send when</legend>
                {OUTBOUND_WEBHOOK_EVENTS.map((event) => (
                  <label key={event} className="flex items-center gap-2">
                    <Checkbox checked={events.includes(event)} onCheckedChange={(checked) => toggleEvent(event, checked === true)} />
                    {OUTBOUND_WEBHOOK_EVENT_LABELS[event]}
                  </label>
                ))}
              </fieldset>
              <DialogFooter>
                <Button type="submit" disabled={!canCreate || create.isPending}>
                  {create.isPending ? "Adding…" : "Add address"}
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
