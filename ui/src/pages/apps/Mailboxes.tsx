import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, LogIn, Mail, Plus, Trash2, X } from "lucide-react";
import type {
  MailboxOAuthAppSummary,
  MailboxOAuthProvider,
  MailboxSummary,
} from "@greatstone/shared";
import { useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { mailboxesApi } from "@/api/mailboxes";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Common IMAP settings. Users still confirm every field.
const PRESETS: Record<string, { host: string; port: number; note: string }> = {
  "gmail.com": {
    host: "imap.gmail.com",
    port: 993,
    note: "Gmail needs 2-step verification and an app password (Google Account → Security → App passwords).",
  },
  "googlemail.com": { host: "imap.gmail.com", port: 993, note: "Use a Google app password." },
  "icloud.com": { host: "imap.mail.me.com", port: 993, note: "Use an app-specific password from your Apple ID." },
  "me.com": { host: "imap.mail.me.com", port: 993, note: "Use an app-specific password from your Apple ID." },
  "yahoo.com": { host: "imap.mail.yahoo.com", port: 993, note: "Use a Yahoo app password." },
  "outlook.com": {
    host: "outlook.office365.com",
    port: 993,
    note: "Microsoft blocks password sign-in for most accounts. Use Sign in with Microsoft instead.",
  },
  "hotmail.com": {
    host: "outlook.office365.com",
    port: 993,
    note: "Microsoft blocks password sign-in for most accounts. Use Sign in with Microsoft instead.",
  },
};

// Sign-in uses the company's own OAuth app. These steps say how to make one.
const SIGN_IN: Record<MailboxOAuthProvider, { name: string; steps: string[] }> = {
  microsoft: {
    name: "Microsoft",
    steps: [
      "In the Microsoft Entra admin center, open App registrations and choose New registration. An admin of your Microsoft 365 tenant must do this.",
      "Under Authentication, add a Web platform with the redirect URI below.",
      "Under API permissions, add Microsoft Graph delegated permissions IMAP.AccessAsUser.All, offline_access, openid and email. Grant admin consent if your tenant asks for it.",
      "Under Certificates & secrets, create a client secret and copy its Value. Note when it expires.",
      "Copy the Application (client) ID and the Directory (tenant) ID from Overview.",
    ],
  },
  google: {
    name: "Google",
    steps: [
      "In Google Cloud console, open APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.",
      "Add the redirect URI below as an authorized redirect URI.",
      "On the OAuth consent screen, add the scope https://mail.google.com/. Choose Internal for a Google Workspace domain; an External app in Testing signs out after 7 days.",
      "Copy the client ID and client secret.",
    ],
  },
};

function SignInPanel({
  provider,
  app,
  agents,
  companyId,
  onClose,
}: {
  provider: MailboxOAuthProvider;
  app: MailboxOAuthAppSummary | undefined;
  agents: Array<{ id: string; name: string }>;
  companyId: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const { name, steps } = SIGN_IN[provider];
  const [editingApp, setEditingApp] = useState(!app?.configured);
  const [settings, setSettings] = useState({ clientId: app?.clientId ?? "", clientSecret: "", tenant: app?.tenant ?? "" });
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState({ allAgents: false, agentIds: new Set<string>() });
  useEffect(() => setEditingApp(!app?.configured), [app?.configured]);

  const saveApp = useMutation({
    mutationFn: () =>
      mailboxesApi.saveOAuthApp(companyId, provider, {
        clientId: settings.clientId.trim(),
        clientSecret: settings.clientSecret,
        ...(provider === "microsoft" && settings.tenant.trim() ? { tenant: settings.tenant.trim() } : {}),
      }),
    onSuccess: () => {
      setSettings((current) => ({ ...current, clientSecret: "" }));
      setEditingApp(false);
      void cache.invalidateQueries({ queryKey: queryKeys.mailboxes.oauthApps(companyId) });
    },
  });
  const start = useMutation({
    mutationFn: () =>
      mailboxesApi.startOAuth(companyId, {
        provider,
        label: label.trim() || undefined,
        allAgents: access.allAgents,
        agentIds: [...access.agentIds],
      }),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">Sign in with {name}</h2>
      {editingApp ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (settings.clientId.trim() && settings.clientSecret) saveApp.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">
            First, connect your own {name} app. You do this once for every mailbox.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-redirect">Redirect URI</Label>
            <Input id="oauth-redirect" readOnly value={app?.redirectUri ?? ""} onFocus={(event) => event.target.select()} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="oauth-client-id">Client ID</Label>
              <Input
                id="oauth-client-id"
                autoComplete="off"
                value={settings.clientId}
                onChange={(event) => setSettings((current) => ({ ...current, clientId: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oauth-client-secret">Client secret</Label>
              <Input
                id="oauth-client-secret"
                type="password"
                autoComplete="new-password"
                value={settings.clientSecret}
                onChange={(event) => setSettings((current) => ({ ...current, clientSecret: event.target.value }))}
              />
            </div>
            {provider === "microsoft" && (
              <div className="space-y-1.5">
                <Label htmlFor="oauth-tenant">Directory (tenant) ID</Label>
                <Input
                  id="oauth-tenant"
                  autoComplete="off"
                  placeholder="organizations"
                  value={settings.tenant}
                  onChange={(event) => setSettings((current) => ({ ...current, tenant: event.target.value }))}
                />
              </div>
            )}
          </div>
          {saveApp.error && (
            <p className="text-sm text-destructive" role="alert">
              {saveApp.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!settings.clientId.trim() || !settings.clientSecret || saveApp.isPending}>
              Save app settings
            </Button>
            <Button type="button" variant="ghost" onClick={app?.configured ? () => setEditingApp(false) : onClose}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            App {app?.clientId}
            {app?.tenant ? ` · tenant ${app.tenant}` : ""} ·{" "}
            <button type="button" className="underline" onClick={() => setEditingApp(true)}>
              Change app settings
            </button>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-label">Name (optional)</Label>
            <Input
              id="oauth-label"
              placeholder="Work, Personal…"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Agents that can read this mailbox</Label>
            <AgentPicker agents={agents} {...access} onChange={setAccess} />
          </div>
          {start.error && (
            <p className="text-sm text-destructive" role="alert">
              {start.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Continue to {name}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type Draft = {
  label: string;
  address: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  allAgents: boolean;
  agentIds: Set<string>;
};

const emptyDraft = (): Draft => ({
  label: "",
  address: "",
  host: "",
  port: "993",
  secure: true,
  username: "",
  password: "",
  allAgents: false,
  agentIds: new Set(),
});

function AgentPicker({
  agents,
  allAgents,
  agentIds,
  onChange,
}: {
  agents: Array<{ id: string; name: string }>;
  allAgents: boolean;
  agentIds: Set<string>;
  onChange: (next: { allAgents: boolean; agentIds: Set<string> }) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={allAgents}
          onCheckedChange={(value) => onChange({ allAgents: value === true, agentIds })}
        />
        All agents
      </label>
      {!allAgents && (
        <div className="grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
          {agents.map((agent) => (
            <label key={agent.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={agentIds.has(agent.id)}
                onCheckedChange={(value) => {
                  const next = new Set(agentIds);
                  if (value === true) next.add(agent.id);
                  else next.delete(agent.id);
                  onChange({ allAgents, agentIds: next });
                }}
              />
              {agent.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function MailboxRow({
  mailbox,
  agents,
  companyId,
  onRemove,
}: {
  mailbox: MailboxSummary;
  agents: Array<{ id: string; name: string }>;
  companyId: string;
  onRemove: () => void;
}) {
  const cache = useQueryClient();
  const { pushToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState({
    allAgents: mailbox.allAgents,
    agentIds: new Set(mailbox.agentIds),
  });
  const refresh = () => cache.invalidateQueries({ queryKey: queryKeys.mailboxes.list(companyId) });
  const test = useMutation({
    mutationFn: () => mailboxesApi.test(companyId, mailbox.id),
    onSuccess: () => {
      void refresh();
      pushToast({ title: "Mailbox works", tone: "success" });
    },
    onError: (error) => {
      void refresh();
      pushToast({
        title: "Mailbox test failed",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const save = useMutation({
    mutationFn: () =>
      mailboxesApi.setAgents(companyId, mailbox.id, {
        allAgents: access.allAgents,
        agentIds: [...access.agentIds],
      }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const reconnect = useMutation({
    mutationFn: () =>
      mailboxesApi.startOAuth(companyId, {
        provider: mailbox.provider as MailboxOAuthProvider,
        label: mailbox.label,
        allAgents: mailbox.allAgents,
        agentIds: mailbox.agentIds,
      }),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
    onError: (error) =>
      pushToast({
        title: "Could not start sign-in",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      }),
  });
  const healthy = mailbox.healthStatus === "ok";
  const oauth = mailbox.provider !== "imap";
  const where = oauth ? `${SIGN_IN[mailbox.provider as MailboxOAuthProvider].name} sign-in` : `${mailbox.host}:${mailbox.port}`;
  const assigned = mailbox.allAgents
    ? "All agents"
    : mailbox.agentIds
        .map((id) => agents.find((agent) => agent.id === id)?.name)
        .filter(Boolean)
        .join(", ") || "No agents yet";
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {healthy ? (
            <Check className="mt-0.5 size-4 text-(--status-agent-active)" aria-label="Connected" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 text-(--status-agent-paused)" aria-label="Needs attention" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {mailbox.label} · {mailbox.address}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {healthy ? "Connected" : (mailbox.healthMessage ?? "Needs attention")} · {where} · {assigned}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:justify-end">
          {oauth && !healthy && (
            <Button size="sm" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
              {reconnect.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              Reconnect
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Test
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
            Agents
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Remove ${mailbox.label}`} onClick={onRemove}>
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {editing && (
        <div className="space-y-2 rounded-md bg-muted/30 p-3">
          <AgentPicker agents={agents} {...access} onChange={setAccess} />
          <div className="flex gap-2">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
        </div>
      )}
    </div>
  );
}

export function Mailboxes() {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const { setBreadcrumbs } = useBreadcrumbs();
  const cache = useQueryClient();
  const { pushToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [removing, setRemoving] = useState<MailboxSummary | null>(null);
  const [signingIn, setSigningIn] = useState<MailboxOAuthProvider | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [signInError, setSignInError] = useState<string | null>(null);

  // The sign-in callback sends the browser back here with its outcome.
  useEffect(() => {
    const connected = searchParams.get("mailboxConnected");
    const failed = searchParams.get("mailboxError");
    if (!connected && !failed) return;
    if (connected) pushToast({ title: `${connected} is connected`, tone: "success" });
    if (failed) setSignInError(failed);
    const next = new URLSearchParams(searchParams);
    next.delete("mailboxConnected");
    next.delete("mailboxError");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, pushToast]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors", href: "/apps" }, { label: "Mailboxes" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const mailboxes = useQuery({
    queryKey: queryKeys.mailboxes.list(companyId),
    queryFn: () => mailboxesApi.list(companyId),
    enabled: !!companyId,
  });
  const oauthApps = useQuery({
    queryKey: queryKeys.mailboxes.oauthApps(companyId),
    queryFn: () => mailboxesApi.oauthApps(companyId),
    enabled: !!companyId,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const agents = (agentsQuery.data ?? [])
    .filter((agent) => !["terminated", "pending_approval"].includes(agent.status))
    .map((agent) => ({ id: agent.id, name: agent.name }));

  const domain = draft.address.split("@")[1]?.toLowerCase() ?? "";
  const preset = PRESETS[domain];
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const connect = useMutation({
    mutationFn: () =>
      mailboxesApi.connect(companyId, {
        label: draft.label.trim() || draft.address.trim(),
        address: draft.address.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        secure: draft.secure,
        username: draft.username.trim() || draft.address.trim(),
        password: draft.password,
        allAgents: draft.allAgents,
        agentIds: [...draft.agentIds],
        idempotencyKey: requestId,
      }),
    onSuccess: (mailbox) => {
      setDraft(emptyDraft());
      setRequestId(crypto.randomUUID());
      setAdding(false);
      void cache.invalidateQueries({ queryKey: queryKeys.mailboxes.list(companyId) });
      pushToast({ title: `${mailbox.address} is connected`, tone: "success" });
    },
    // A failed sign-in stored nothing; a fresh key lets the user retry.
    onError: () => setRequestId(crypto.randomUUID()),
  });
  const remove = useMutation({
    mutationFn: (mailbox: MailboxSummary) => mailboxesApi.remove(companyId, mailbox.id),
    onSuccess: () => {
      setRemoving(null);
      void cache.invalidateQueries({ queryKey: queryKeys.mailboxes.list(companyId) });
      pushToast({ title: "Mailbox removed", tone: "success" });
    },
  });

  const canSubmit =
    draft.address.includes("@") &&
    draft.host.trim() &&
    Number(draft.port) > 0 &&
    draft.password &&
    !connect.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Mail className="size-5" aria-hidden="true" /> Mailboxes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Link your mailboxes so assigned agents can search and read them and save an email to a
            task. Agents cannot send, move or delete mail. Passwords and sign-ins stay in the secret
            store.
          </p>
        </div>
        {!adding && !signingIn && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setSigningIn("microsoft")}>
              <LogIn className="size-4" aria-hidden="true" /> Sign in with Microsoft
            </Button>
            <Button variant="outline" onClick={() => setSigningIn("google")}>
              <LogIn className="size-4" aria-hidden="true" /> Sign in with Google
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden="true" /> Add mailbox
            </Button>
          </div>
        )}
      </header>

      {signInError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm" role="alert">
          <AlertTriangle className="mt-0.5 size-4 text-destructive" aria-hidden="true" />
          <p className="flex-1">{signInError}</p>
          <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => setSignInError(null)}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {signingIn && (
        <SignInPanel
          key={signingIn}
          provider={signingIn}
          app={oauthApps.data?.find((app) => app.provider === signingIn)}
          agents={agents}
          companyId={companyId}
          onClose={() => setSigningIn(null)}
        />
      )}

      {adding && (
        <form
          className="space-y-4 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) connect.mutate();
          }}
        >
          <h2 className="text-sm font-semibold">Add an IMAP mailbox</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mailbox-address">Email address</Label>
              <Input
                id="mailbox-address"
                type="email"
                autoComplete="off"
                value={draft.address}
                onChange={(event) => {
                  const address = event.target.value;
                  const next = PRESETS[address.split("@")[1]?.toLowerCase() ?? ""];
                  set({ address, ...(next && !draft.host ? { host: next.host, port: String(next.port) } : {}) });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mailbox-label">Name (optional)</Label>
              <Input
                id="mailbox-label"
                placeholder="Work, Personal…"
                value={draft.label}
                onChange={(event) => set({ label: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mailbox-host">IMAP server</Label>
              <Input
                id="mailbox-host"
                placeholder="imap.example.com"
                value={draft.host}
                onChange={(event) => set({ host: event.target.value })}
              />
            </div>
            <div className="flex gap-3">
              <div className="w-24 space-y-1.5">
                <Label htmlFor="mailbox-port">Port</Label>
                <Input
                  id="mailbox-port"
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(event) => set({ port: event.target.value.replace(/\D/g, "") })}
                />
              </div>
              <label className="mt-7 flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.secure}
                  onCheckedChange={(value) => set({ secure: value === true })}
                />
                Use TLS
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mailbox-username">Username (usually the address)</Label>
              <Input
                id="mailbox-username"
                autoComplete="off"
                placeholder={draft.address}
                value={draft.username}
                onChange={(event) => set({ username: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mailbox-password">App password</Label>
              <Input
                id="mailbox-password"
                type="password"
                autoComplete="new-password"
                value={draft.password}
                onChange={(event) => set({ password: event.target.value })}
              />
            </div>
          </div>
          {preset && <p className="text-xs text-muted-foreground">{preset.note}</p>}
          {!draft.secure && (
            <p className="text-xs text-(--status-agent-paused)">
              Without TLS the password and mail travel unencrypted. Use this only on a trusted network.
            </p>
          )}
          <div className="space-y-1.5">
            <Label>Agents that can read this mailbox</Label>
            <AgentPicker
              agents={agents}
              allAgents={draft.allAgents}
              agentIds={draft.agentIds}
              onChange={(next) => set(next)}
            />
          </div>
          {connect.error && (
            <p className="text-sm text-destructive" role="alert">
              {connect.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={!canSubmit}>
              {connect.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {connect.isPending ? "Signing in…" : "Connect"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setDraft(emptyDraft());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <section className="rounded-lg border border-border">
        {mailboxes.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : mailboxes.error ? (
          <p className="p-4 text-sm text-destructive">{mailboxes.error.message}</p>
        ) : mailboxes.data?.length ? (
          <div className="divide-y divide-border">
            {mailboxes.data.map((mailbox) => (
              <MailboxRow
                key={mailbox.id}
                mailbox={mailbox}
                agents={agents}
                companyId={companyId}
                onRemove={() => setRemoving(mailbox)}
              />
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No mailboxes yet.</p>
        )}
      </section>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.address}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents lose access right away and the saved password is deleted. Emails already saved
              to tasks stay on those tasks.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removing && remove.mutate(removing)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
