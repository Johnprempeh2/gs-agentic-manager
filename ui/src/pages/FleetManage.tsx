import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";
import { ENTITLEMENT_FEATURE_KEYS, INSTANCE_FEATURE_CATALOG } from "@greatstone/shared";
import type { FleetEntitlementSummary, FleetInstanceView, FleetOrderKind, FleetOrderView } from "@greatstone/shared/fleet";
import { fleetApi, type FleetEntitlementBody } from "@/api/fleet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";

/**
 * GSAM for Mac admin controls on the hub Fleet page (P2): new licence keys,
 * features, limits and paid-until, signed orders, and remote access. The hub
 * signs everything; the install checks each document and order against the
 * hub key it pinned at activation.
 */

/** Limits the form offers. Any other limit already in a document is kept. */
const LIMIT_FIELDS: Array<{ key: string; label: string }> = [
  { key: "maxUsers", label: "Users" },
  { key: "maxAgents", label: "Agents" },
];

/** The REMOTE port the tailnet policy opens (tag:gsam-customer:3100). */
const REMOTE_PORT = 3100;

function featureTitle(key: string) {
  // "(compatibility)" in a catalogue title is a note for operators, not part of what is sold.
  return ((INSTANCE_FEATURE_CATALOG as Record<string, { title: string } | undefined>)[key]?.title ?? key).replace(/ \(compatibility\)$/, "");
}

export function dateOnly(iso: string) {
  return iso.slice(0, 10);
}

/** British date, for example 24 Dec 2026. */
export function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        await copyTextToClipboard(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Secret({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs" data-testid={testId}>
          {value}
        </code>
        <CopyButton value={value} label={label.toLowerCase()} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error instanceof Error ? error.message : "That did not work. Try again."}
    </p>
  );
}

/** Features, limits, paid-until and reason. Used for a new licence and for a new document. */
function EntitlementFields({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  extra,
}: {
  initial: FleetEntitlementSummary | null;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: FleetEntitlementBody) => void;
  extra?: ReactNode;
}) {
  const [features, setFeatures] = useState<Record<string, boolean>>(() => ({ ...(initial?.features ?? {}) }));
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(initial?.limits ?? {}).map(([key, value]) => [key, String(value)])),
  );
  const [paidUntil, setPaidUntil] = useState(() => dateOnly(initial?.validUntil ?? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()));
  const [reason, setReason] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanLimits: Record<string, number> = {};
    for (const [key, value] of Object.entries(limits)) {
      const n = Number.parseInt(value, 10);
      if (value.trim() !== "" && Number.isFinite(n) && n >= 0) cleanLimits[key] = n;
    }
    onSubmit({
      features: Object.fromEntries(ENTITLEMENT_FEATURE_KEYS.map((key) => [key, features[key] === true])),
      limits: cleanLimits,
      // The end of the chosen day (UTC): the service stops after it.
      validUntil: `${paidUntil}T23:59:59Z`,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      {extra}
      <fieldset className="space-y-2">
        <legend className="text-xs text-muted-foreground">Features</legend>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {ENTITLEMENT_FEATURE_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={features[key] === true} onCheckedChange={(checked) => setFeatures((prev) => ({ ...prev, [key]: checked === true }))} />
              {featureTitle(key)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        {LIMIT_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`limit-${field.key}`}>{field.label}</Label>
            <Input
              id={`limit-${field.key}`}
              inputMode="numeric"
              placeholder="No limit"
              value={limits[field.key] ?? ""}
              onChange={(event) => setLimits((prev) => ({ ...prev, [field.key]: event.target.value }))}
            />
          </div>
        ))}
        <div className="space-y-1">
          <Label htmlFor="paid-until">Paid until</Label>
          <Input id="paid-until" type="date" required value={paidUntil} onChange={(event) => setPaidUntil(event.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="entitlement-reason">Reason (kept on the hub and in the activity log)</Label>
        <Input id="entitlement-reason" placeholder="Monthly plan, CRM package" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <ErrorText error={error} />
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending ? "Signing..." : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NewLicenceButton() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const create = useMutation({
    mutationFn: (body: FleetEntitlementBody) => fleetApi.createLicence({ ...body, ...(code.trim() ? { code: code.trim() } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetInstances }),
  });
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // The key is shown once: closing the dialog forgets it.
      create.reset();
      setCode("");
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <Button type="button" onClick={() => setOpen(true)} data-testid="fleet-new-licence">
        <KeyRound />
        New licence
      </Button>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New licence</DialogTitle>
          <DialogDescription>A licence key for one GSAM for Mac install. It works once and expires in 30 days if nobody uses it.</DialogDescription>
        </DialogHeader>
        {create.data ? (
          <div className="space-y-4" data-testid="fleet-licence-created">
            <p className="text-sm">
              Licence for <span className="font-mono">{create.data.instance.code}</span>. Copy the key now: it is not shown again.
            </p>
            <Secret label="Licence key" value={create.data.licenceKey} testId="fleet-licence-key" />
            <p className="text-xs text-muted-foreground">Unused, it expires on {formatDay(create.data.licenceKeyExpiresAt)}.</p>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <EntitlementFields
            initial={null}
            submitLabel="Make licence key"
            pending={create.isPending}
            error={create.error}
            onSubmit={(body) => create.mutate(body)}
            extra={
              <div className="space-y-1">
                <Label htmlFor="licence-code">Install code (optional)</Label>
                <Input id="licence-code" placeholder="mac-1a2b3c4d (made for you when empty)" value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const ORDER_LABEL: Record<FleetOrderKind, string> = {
  pause: "Pause",
  resume: "Resume",
  stop: "Stop service",
  update: "Update now",
};

const ORDER_HELP: Record<FleetOrderKind, string> = {
  pause: "Agents stop starting new work. The customer can still use GSAM.",
  resume: "Lifts a pause or a stop. Agents start again.",
  stop: "Agents stop and GSAM shows \"Service stopped by Greatstone\". Data stays on the Mac and can be exported.",
  update: "Installs the newest GSAM release now instead of tonight.",
};

const ORDER_STATUS: Record<FleetOrderView["status"], string> = {
  pending: "Waiting for the next check-in",
  done: "Done",
  failed: "Failed",
  refused: "Refused",
  expired: "Expired, never collected",
};

function OrderList({ orders }: { orders: FleetOrderView[] }) {
  if (orders.length === 0) return <p className="text-sm text-muted-foreground">No orders yet.</p>;
  return (
    <ul className="space-y-2" data-testid="fleet-orders">
      {orders.map((order) => (
        <li key={order.id} className="text-sm">
          <div>
            <span className="font-medium">{ORDER_LABEL[order.kind]}</span>{" "}
            <span className={order.status === "failed" || order.status === "refused" || order.status === "expired" ? "text-destructive" : "text-muted-foreground"}>
              {ORDER_STATUS[order.status]}
              {order.resultCode ? ` (${order.resultCode.replace(/_/g, " ")})` : ""}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {order.issuedBy}, {relativeTime(order.createdAt)}: {order.reason}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Orders({ instance }: { instance: FleetInstanceView }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const send = useMutation({
    mutationFn: (kind: FleetOrderKind) => fleetApi.createOrder(instance.id, { kind, reason: reason.trim() }),
    onSuccess: () => {
      setReason("");
      setConfirmStop(false);
      return queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetInstances });
    },
  });
  if (instance.status !== "active") {
    return <p className="text-sm text-muted-foreground">Orders work once the install has activated its licence.</p>;
  }
  const kinds: FleetOrderKind[] = ["pause", "resume", "update", "stop"];
  const noReason = reason.trim() === "";
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`order-reason-${instance.code}`}>Why (required, kept on the hub and in the activity log)</Label>
        <Textarea id={`order-reason-${instance.code}`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind) =>
          kind === "stop" ? (
            <Button
              key={kind}
              type="button"
              variant={confirmStop ? "destructive" : "outline"}
              disabled={noReason || send.isPending}
              title={ORDER_HELP[kind]}
              onClick={() => (confirmStop ? send.mutate("stop") : setConfirmStop(true))}
            >
              {confirmStop ? "Confirm: stop the service" : ORDER_LABEL[kind]}
            </Button>
          ) : (
            <Button key={kind} type="button" variant="outline" disabled={noReason || send.isPending} title={ORDER_HELP[kind]} onClick={() => send.mutate(kind)}>
              {ORDER_LABEL[kind]}
            </Button>
          ),
        )}
      </div>
      {confirmStop ? <p className="text-sm">{ORDER_HELP.stop}</p> : null}
      <p className="text-xs text-muted-foreground">Signed with the hub key. The install obeys it at its next check-in, within 5 minutes, and reports back.</p>
      <ErrorText error={send.error} />
      <OrderList orders={instance.orders ?? []} />
    </div>
  );
}

export function remoteAddress(instance: FleetInstanceView): string | null {
  const checkIn = instance.latestCheckIn?.checkIn;
  const name = checkIn && "remote" in checkIn ? checkIn.remote.tailnetName : null;
  return name ? `http://${name}:${REMOTE_PORT}` : null;
}

function RemoteAccess({ instance }: { instance: FleetInstanceView }) {
  const reveal = useMutation({ mutationFn: () => fleetApi.operatorLogin(instance.id) });
  const address = remoteAddress(instance);
  return (
    <div className="space-y-3">
      {address ? (
        <Button asChild variant="outline">
          <a href={address} target="_blank" rel="noreferrer" data-testid="fleet-open-remote">
            <ExternalLink />
            Open remotely
          </a>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="fleet-no-remote">
          No tailnet address yet. The install joins Greatstone's tailnet when the hub hands it a Tailscale key at activation.
        </p>
      )}
      {instance.operatorEmail ? (
        reveal.data ? (
          <div className="space-y-2" data-testid="fleet-operator-login">
            <Secret label="Email" value={reveal.data.email} testId="fleet-operator-email" />
            <Secret label="Password" value={reveal.data.password} testId="fleet-operator-password" />
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate()} data-testid="fleet-reveal-operator">
            Show operator log-in
          </Button>
        )
      ) : (
        <p className="text-sm text-muted-foreground">No operator log-in: the install has not activated yet.</p>
      )}
      <p className="text-xs text-muted-foreground">Each time the log-in is shown, it is written to the hub activity log.</p>
      <ErrorText error={reveal.error} />
    </div>
  );
}

function Subscription({ instance }: { instance: FleetInstanceView }) {
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: (body: FleetEntitlementBody) => fleetApi.issueEntitlement(instance.id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetInstances }),
  });
  return (
    <div className="space-y-2">
      {issue.isSuccess ? (
        <p className="text-sm" role="status">
          Version {issue.data.entitlementVersion} signed. The install applies it at its next check-in.
        </p>
      ) : null}
      <EntitlementFields
        key={instance.entitlement?.version ?? 0}
        initial={instance.entitlement ?? null}
        submitLabel="Sign new version"
        pending={issue.isPending}
        error={issue.error}
        onSubmit={(body) => issue.mutate(body)}
      />
    </div>
  );
}

export function ManageInstanceButton({ instance }: { instance: FleetInstanceView }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`fleet-manage-${instance.code}`}>
        Manage
      </Button>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{instance.code}</DialogTitle>
          <DialogDescription>
            {instance.entitlement
              ? `Document version ${instance.entitlement.version}, paid until ${formatDay(instance.entitlement.validUntil)}.`
              : "No signed document from this hub."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Section title="Remote access">
            <RemoteAccess instance={instance} />
          </Section>
          <Section title="Orders">
            <Orders instance={instance} />
          </Section>
          <Section title="Features, limits and paid until">
            <Subscription instance={instance} />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
