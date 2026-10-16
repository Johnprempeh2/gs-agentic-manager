import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import type { ActivityEvent, InboundTaskHookSummary, MailboxSummary, OutboundWebhookSummary, ToolConnection } from "@greatstone/shared";
import { isToolConnectionAttentionHealth } from "@greatstone/shared";
import { activityApi } from "@/api/activity";
import { calendarApi } from "@/api/calendar";
import { inboundTaskHooksApi } from "@/api/inboundTaskHooks";
import { mailboxesApi } from "@/api/mailboxes";
import { outboundWebhooksApi } from "@/api/outboundWebhooks";
import { toolsApi } from "@/api/tools";
import { CalendarFeedDialog, calendarFeedKey, calendarFeedStatusLine } from "@/components/CalendarFeed";
import { InboundTaskHooksDialog, hookStatusLine, inboundHooksKey } from "@/components/InboundTaskHooks";
import { OutboundWebhooksDialog, outboundStatusLine, outboundWebhooksKey } from "@/components/OutboundWebhooks";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { AppLogo } from "@/pages/apps/AppLogo";
import { appSourceConnectHref, appSourceResumeHref } from "@/pages/apps/app-connect-policy";

/** Where one integration stands, in words a non-technical person can act on. */
export type IntegrationState = "connected" | "imported" | "attention" | "off" | "unfinished" | "not_connected";

const STATE_BADGE: Record<IntegrationState, { status: string; label: string }> = {
  connected: { status: "ok", label: "Connected" },
  imported: { status: "ok", label: "Imported from a file" },
  attention: { status: "error", label: "Needs attention" },
  off: { status: "unchecked", label: "Turned off" },
  unfinished: { status: "warning", label: "Setup not finished" },
  not_connected: { status: "unchecked", label: "Not connected" },
};

export interface IntegrationCardDef {
  /** Apps catalog slug, or "mailboxes" for the built-in email inboxes. */
  slug: string;
  name: string;
  /** What it lets GSAM and the agents do, in one or two plain sentences. */
  does: string;
  extra?: { label: string; to: string };
  /** A caveat shown under the description, such as a provider's own access step. */
  note?: string;
  /** For tools not in the Apps catalogue: the button when nothing is connected. */
  withoutConnection?: { label: string; to: string };
}

const GOOGLE_PREVIEW_NOTE = "Google still limits this to its preview programme, so setup asks you to request access first.";

/** The integrations most teams need, in the order a new team usually sets them up. */
export const INTEGRATIONS: IntegrationCardDef[] = [
  {
    slug: "pipedrive",
    name: "Pipedrive",
    does: "Brings your organisations, people, deals and activities into GSAM, so agents work from the same client list as you.",
    extra: { label: "No API key? Upload a Pipedrive export", to: "/organisations" },
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    does: "Brings your HubSpot companies, contacts and deals into GSAM from the files HubSpot exports. No HubSpot key needed.",
    withoutConnection: { label: "Upload export", to: "/organisations" },
  },
  {
    slug: "mailboxes",
    name: "Email inboxes",
    does: "Lets agents search your inboxes and prepare replies. Works with Gmail, Outlook or any IMAP mailbox.",
  },
  {
    slug: "google-calendar",
    note: GOOGLE_PREVIEW_NOTE,
    name: "Google Calendar",
    does: "Lets agents see when you are free and suggest meeting times.",
  },
  {
    slug: "gmail",
    note: GOOGLE_PREVIEW_NOTE,
    name: "Gmail",
    does: "Lets agents read, label and draft email in a Google mailbox through Google's own sign-in.",
  },
  {
    slug: "google-drive",
    note: GOOGLE_PREVIEW_NOTE,
    name: "Google Drive",
    does: "Lets agents find and read the files and folders you share with them.",
  },
  {
    slug: "google-docs",
    note: GOOGLE_PREVIEW_NOTE,
    name: "Google Docs",
    does: "Lets agents write proposals, briefs and notes straight into Google Docs.",
  },
  {
    slug: "notion",
    name: "Notion",
    does: "Lets agents read and update your Notion pages and databases, such as client notes.",
  },
  {
    slug: "slack",
    name: "Slack",
    does: "Lets you message your agents and get their updates in Slack.",
  },
];

/** The company's connection for an Apps catalog slug, preferring a working one. */
export function connectionForSlug(connections: ToolConnection[], slug: string) {
  const matches = connections.filter(
    (connection) => (connection.config ?? connection.transportConfig)?.sourceTemplateKey === slug,
  );
  return matches.find((connection) => connection.status === "active" && connection.enabled)
    ?? matches.find((connection) => connection.status === "active")
    ?? matches[0]
    ?? null;
}

export function connectionState(connection: ToolConnection | null): IntegrationState {
  if (!connection) return "not_connected";
  if (connection.status !== "active") return "unfinished";
  if (!connection.enabled) return "off";
  if (isToolConnectionAttentionHealth(connection.healthStatus)) return "attention";
  return "connected";
}

export function mailboxState(mailboxes: MailboxSummary[]): IntegrationState {
  if (mailboxes.length === 0) return "not_connected";
  const failing = (status: string) => ["error", "failed", "auth_failed", "unreachable"].includes(status);
  return mailboxes.every((mailbox) => failing(mailbox.healthStatus)) ? "attention" : "connected";
}

type ImportCounts = { created?: number; updated?: number; errors?: number };

const IMPORT_PARTS: Array<{ key: string; one: string; many: string }> = [
  { key: "organisations", one: "organisation", many: "organisations" },
  { key: "contacts", one: "person", many: "people" },
  { key: "deals", one: "deal", many: "deals" },
  { key: "activities", one: "activity", many: "activities" },
];

function joinWords(parts: string[]) {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * One plain sentence on an import: when it ran, what came in and how many rows
 * failed. Built from the `organisation.import_completed` activity entry.
 */
export function describeImport(event: Pick<ActivityEvent, "createdAt" | "details">, when = relativeTime(event.createdAt)) {
  const details = (event.details ?? {}) as Record<string, ImportCounts | undefined>;
  const counted = (pick: (counts: ImportCounts) => number) =>
    IMPORT_PARTS.flatMap(({ key, one, many }) => {
      const value = details[key] ? pick(details[key]!) : 0;
      return value > 0 ? [`${value} ${value === 1 ? one : many}`] : [];
    });
  const added = counted((counts) => counts.created ?? 0);
  const updated = counted((counts) => counts.updated ?? 0);
  const errors = IMPORT_PARTS.reduce((sum, { key }) => sum + (details[key]?.errors ?? 0), 0);
  const parts: string[] = [];
  if (added.length) parts.push(`${joinWords(added)} added`);
  if (updated.length) parts.push(`${joinWords(updated)} updated`);
  const what = parts.length ? parts.join("; ") : "nothing new";
  const failed = errors > 0 ? ` ${errors} ${errors === 1 ? "row" : "rows"} could not be imported.` : "";
  return `Last import ${when}: ${what}.${failed}`;
}

/** The health problem on a connection or inbox, in words, or null when it is fine. */
export function problemInWords(message: string | null | undefined) {
  const text = message?.trim();
  if (!text) return "It stopped working. Open it to see what went wrong and reconnect.";
  return `Problem: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

/** The status line for a catalog connection: a problem first, else when it was last used or checked. */
export function connectionStatusLine(connection: ToolConnection, state: IntegrationState) {
  if (state === "attention") return problemInWords(connection.healthMessage ?? connection.lastError);
  if (state === "off") return "Turned off, so agents cannot use it until you turn it back on.";
  if (connection.lastUsedAt) return `Last used by an agent ${relativeTime(connection.lastUsedAt)}.`;
  const checked = connection.lastHealthAt ?? connection.healthCheckedAt;
  if (checked) return `Last checked ${relativeTime(checked)}. No agent has used it yet.`;
  return null;
}

/** The status line for the email inboxes: the first failing inbox, else when they were last checked. */
export function mailboxStatusLine(mailboxes: MailboxSummary[]) {
  const failing = mailboxes.find((mailbox) => ["error", "failed", "auth_failed", "unreachable"].includes(mailbox.healthStatus));
  if (failing) return `${failing.address}: ${problemInWords(failing.healthMessage)}`;
  const checked = mailboxes
    .map((mailbox) => mailbox.healthCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  return checked ? `Last checked ${relativeTime(checked)}.` : null;
}

/** Where the incoming webhooks stand: none, all off, a recent problem, or working. */
export function webhookState(hooks: InboundTaskHookSummary[]): IntegrationState {
  const live = hooks.filter((hook) => hook.enabled);
  if (hooks.length === 0) return "not_connected";
  if (live.length === 0) return "off";
  const failing = (hook: InboundTaskHookSummary) =>
    Boolean(hook.lastErrorAt) && (!hook.lastUsedAt || hook.lastErrorAt! > hook.lastUsedAt);
  return live.every(failing) ? "attention" : "connected";
}

const WEBHOOK_DEF: IntegrationCardDef = {
  slug: "webhook",
  name: "Incoming webhook",
  does: "Lets a form, Zapier, Make or any outside tool create a task here, with files attached, by posting to a private address.",
};

/** Where the outbound webhooks stand: none, all off, every live one failing, or working. */
export function outboundState(webhooks: OutboundWebhookSummary[]): IntegrationState {
  const live = webhooks.filter((webhook) => webhook.enabled);
  if (webhooks.length === 0) return "not_connected";
  if (live.length === 0) return "off";
  return live.every((webhook) => webhook.lastDeliveryOk === false) ? "attention" : "connected";
}

const OUTBOUND_DEF: IntegrationCardDef = {
  slug: "outbound-webhook",
  name: "Updates to Slack, Teams or Zapier",
  does: "Posts a message to a Slack or Teams channel, Zapier or Make when a task is done, a decision is needed or a client moves stage.",
};

const CALENDAR_FEED_DEF: IntegrationCardDef = {
  slug: "calendar-feed",
  name: "Deadlines in your calendar",
  does: "Shows task due dates and goal dates in Google Calendar, Outlook or Apple Calendar through a private subscription address. No Google or Microsoft keys needed.",
};

function IntegrationCard({
  def,
  state,
  detail,
  status,
  primary,
}: {
  def: IntegrationCardDef;
  state: IntegrationState | null;
  detail: string | null;
  /** Last sync, what came in, or what is wrong, in one or two plain sentences. */
  status?: string[];
  /** A link, or a button that opens a dialog on this page. */
  primary: { label: string; to?: string; onClick?: () => void };
}) {
  const badge = state ? STATE_BADGE[state] : null;
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      data-testid={`integration-${def.slug}`}
    >
      <div className="flex items-start gap-3">
        <AppLogo name={def.name} brandKey={def.slug === "mailboxes" ? "gmail" : def.slug} size={36} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{def.name}</h2>
            {badge ? <StatusBadge status={badge.status} label={badge.label} /> : null}
          </div>
          <p className="text-sm text-muted-foreground">{def.does}</p>
          {def.note && state !== "connected" ? <p className="text-xs text-muted-foreground">{def.note}</p> : null}
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
          {status?.map((line) => (
            <p
              key={line}
              className={state === "attention" && line.includes("Problem") ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              data-testid={`integration-${def.slug}-status`}
            >
              {line}
            </p>
          ))}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        {def.extra ? (
          <Link to={def.extra.to} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {def.extra.label}
          </Link>
        ) : <span />}
        {primary.to ? (
          <Button asChild size="sm" variant={state === "connected" ? "outline" : "default"}>
            <Link to={primary.to}>{primary.label}</Link>
          </Button>
        ) : (
          <Button size="sm" variant={state === "connected" ? "outline" : "default"} onClick={primary.onClick}>
            {primary.label}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Settings > Integrations: the handful of outside tools GSAM works with, each
 * with what it does, where it stands and one button to connect or manage it.
 * The full catalogue stays in Apps; this page is the short list for people
 * who do not want to browse it.
 */
export function Integrations() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Integrations" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
    enabled: Boolean(selectedCompanyId),
  });
  const mailboxes = useQuery({
    queryKey: queryKeys.mailboxes.list(companyId),
    queryFn: () => mailboxesApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
  });

  const imports = useQuery({
    queryKey: [...queryKeys.activity(companyId), "integration-imports"],
    queryFn: () => activityApi.list(companyId, { action: ["organisation.import_completed"], limit: 20 }),
    enabled: Boolean(selectedCompanyId),
  });

  const [hooksOpen, setHooksOpen] = useState(false);
  const hooks = useQuery({
    queryKey: inboundHooksKey(companyId),
    queryFn: () => inboundTaskHooksApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
  });
  const [outboundOpen, setOutboundOpen] = useState(false);
  const outbound = useQuery({
    queryKey: outboundWebhooksKey(companyId),
    queryFn: () => outboundWebhooksApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
  });
  const [feedOpen, setFeedOpen] = useState(false);
  const feed = useQuery({
    queryKey: calendarFeedKey(companyId),
    queryFn: () => calendarApi.feedStatus(companyId),
    enabled: Boolean(selectedCompanyId),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Choose an organisation to see its integrations.</div>;
  }

  const connectionList = connections.data?.connections ?? [];
  /** Newest import per source, such as `pipedrive`. */
  const lastImport = (source: string) =>
    (imports.data ?? [])
      .filter((event) => (event.details as { source?: unknown } | null)?.source === source)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Integrations</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect the tools your team already uses so agents can work with them on your behalf. Nothing is switched on
          until you connect it, and you choose which agents may use each one.
        </p>
      </div>

      {connections.error ? (
        <p className="text-sm text-destructive" role="alert">
          Could not load your connections. {(connections.error as Error).message}
        </p>
      ) : null}

      <ul className="grid gap-3 md:grid-cols-2" aria-label="Integrations">
        {INTEGRATIONS.map((def) => {
          if (def.slug === "mailboxes") {
            const list = mailboxes.data ?? [];
            const state = mailboxes.isLoading || mailboxes.error ? null : mailboxState(list);
            return (
              <IntegrationCard
                key={def.slug}
                def={def}
                state={state}
                detail={list.length > 0 ? `${list.length} ${list.length === 1 ? "inbox" : "inboxes"}: ${list.map((item) => item.address).join(", ")}` : null}
                status={[mailboxStatusLine(list)].filter((line): line is string => Boolean(line))}
                primary={{ label: list.length > 0 ? "Manage" : "Connect", to: "/apps/mailboxes" }}
              />
            );
          }
          const connection = connectionForSlug(connectionList, def.slug);
          const imported = lastImport(def.slug);
          const baseState = connections.isLoading || connections.error ? null : connectionState(connection);
          const state = baseState === "not_connected" && def.withoutConnection && imported ? "imported" : baseState;
          const primary = !connection
            ? def.withoutConnection ?? { label: "Connect", to: appSourceConnectHref(def.slug) }
            : state === "unfinished"
              ? { label: "Finish setup", to: appSourceResumeHref(def.slug, connection.id) }
              : { label: state === "attention" ? "Fix" : "Manage", to: `/apps/${connection.id}` };
          const status = [
            connection && state ? connectionStatusLine(connection, state) : null,
            imported ? describeImport(imported) : null,
          ].filter((line): line is string => Boolean(line));
          return (
            <IntegrationCard
              key={def.slug}
              def={def}
              state={state}
              detail={connection && state !== "unfinished" ? `Connected as “${connection.name}”.` : null}
              status={status}
              primary={primary}
            />
          );
        })}
      </ul>

      <div className="space-y-1 pt-2">
        <h2 className="text-sm font-semibold">Built into GSAM</h2>
        <p className="text-sm text-muted-foreground">These need no outside account or key. Each stays off until you turn it on.</p>
      </div>
      <ul className="grid gap-3 md:grid-cols-2" aria-label="Built-in integrations">
        <IntegrationCard
          def={WEBHOOK_DEF}
          state={hooks.isLoading || hooks.error ? null : webhookState(hooks.data ?? [])}
          detail={hooks.data?.length ? `${hooks.data.length} ${hooks.data.length === 1 ? "address" : "addresses"}: ${hooks.data.map((hook) => hook.name).join(", ")}` : null}
          status={(hooks.data ?? []).slice(0, 2).map((hook) => `${hook.name}: ${hookStatusLine(hook)}`)}
          primary={{ label: hooks.data?.length ? "Manage" : "Set up", onClick: () => setHooksOpen(true) }}
        />
        <IntegrationCard
          def={OUTBOUND_DEF}
          state={outbound.isLoading || outbound.error ? null : outboundState(outbound.data ?? [])}
          detail={outbound.data?.length ? `${outbound.data.length} ${outbound.data.length === 1 ? "address" : "addresses"}: ${outbound.data.map((webhook) => webhook.name).join(", ")}` : null}
          status={(outbound.data ?? []).slice(0, 2).map((webhook) => `${webhook.name}: ${outboundStatusLine(webhook)}`)}
          primary={{ label: outbound.data?.length ? "Manage" : "Set up", onClick: () => setOutboundOpen(true) }}
        />
        <IntegrationCard
          def={CALENDAR_FEED_DEF}
          state={feed.isLoading || feed.error ? null : feed.data?.enabled ? "connected" : "off"}
          detail={null}
          status={[calendarFeedStatusLine(feed.data)].filter((line): line is string => Boolean(line))}
          primary={{ label: feed.data?.enabled ? "Manage" : "Turn on", onClick: () => setFeedOpen(true) }}
        />
      </ul>
      <InboundTaskHooksDialog companyId={companyId} open={hooksOpen} onOpenChange={setHooksOpen} />
      <OutboundWebhooksDialog companyId={companyId} open={outboundOpen} onOpenChange={setOutboundOpen} />
      <CalendarFeedDialog companyId={companyId} open={feedOpen} onOpenChange={setFeedOpen} />

      <p className="text-sm text-muted-foreground">
        Looking for something else? <Link to="/apps" className="underline underline-offset-2">Browse every app</Link>.
      </p>
    </div>
  );
}
