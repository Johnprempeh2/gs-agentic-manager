import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE } from "@greatstone/shared";
import { ManagedAiConnectionRow } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Link2,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Plus,
  Search,
  ServerCog,
  Stethoscope,
  Trash2,
} from "lucide-react";
import type { ToolApplication, ToolConnection } from "@greatstone/shared";
import {
  getAppDefinitionForUrl,
  isMemoryConnectorId,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
  aiSubscriptionNeedsIsolatedLogin,
  aiCredentialExpired,
} from "@greatstone/shared";
import { useNavigate } from "@/lib/router";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { useMemoryConnectorsEnabled } from "@/hooks/useMemoryConnectorsEnabled";
import { appCopyFor } from "@/lib/app-gallery-copy";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { accessApi } from "@/api/access";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionDescription,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import {
  appSourceConnectHref,
  appSourceResumeHref,
  appSupportsToolCatalogSetup,
} from "./app-connect-policy";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";
import {
  connectionCheckedLabel,
  connectionHealthBadge,
  startOAuthReconnect,
} from "./connection-health";
import { CLIENT_BRAND_NAME } from "@/lib/client-brand";

type ConnectorRowModel = {
  key: string;
  slug: string;
  name: string;
  description: string;
  brandKey: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  entry: AppGalleryDisplayEntry | null;
  applications: ToolApplication[];
  connections: ToolConnection[];
  chatEndpoints: ChatEndpoint[];
};

type ConnectionState = {
  kind: "connected" | "attention" | "paused" | "draft";
  label: string;
  message: string | null;
};

type ConnectionRemovalTarget = {
  kind?: "chat";
  id: string;
  accountName: string;
  providerName: string;
  remainingConnectionCount: number;

};

type ResumeTarget =
  | { kind: "chat"; id: string }
  | { kind: "tool"; id: string; status?: ToolConnection["status"] };

/** Which part of the page a card renders in; it shows only that part's accounts. */
type CardSection = "connected" | "unfinished" | "available";

function isUnfinishedEndpoint(endpoint: ChatEndpoint): boolean {
  return endpoint.status === "draft" || endpoint.status === "verifying";
}

function chatProviderForSlug(slug: string): ChatProvider | null {
  const method = getAppStoreDefinition(slug)?.methods.find(
    (candidate) =>
      candidate.purpose === "channel" &&
      candidate.provider,
  );
  return method?.provider ?? null;
}

function chatConnectHref(
  slug: string,
  toolHref: string | null,
  agentId?: string | null,
): string | null {
  const definition = getAppStoreDefinition(slug);
  const provider = chatProviderForSlug(slug);
  if (!definition || !provider) return null;
  const params = new URLSearchParams({ provider });
  const hasToolMethod = definition.methods.some(
    (method) => method.purpose === "tool" && method.transport !== "chat_sdk",
  );
  const effectiveToolHref = hasToolMethod
    ? (toolHref ?? `/apps/connect?source=${slug}`)
    : null;
  if (effectiveToolHref) params.set("toolHref", effectiveToolHref);
  else params.set("purpose", "chat");
  if (agentId) params.set("agentId", agentId);
  return `/apps/chat/connect?${params.toString()}`;
}

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  const definition = getAppStoreDefinition(slug);
  return appSupportsToolCatalogSetup(definition)
    ? appSourceConnectHref(slug)
    : null;
}

function additionalConnectionHref(
  entry: AppGalleryDisplayEntry,
  applicationId: string,
): string | null {
  const baseHref = connectHrefFor(entry);
  if (!baseHref) return null;
  const [path, rawQuery = ""] = baseHref.split("?");
  const params = new URLSearchParams(rawQuery);
  params.set("applicationId", applicationId);
  params.set("name", appDefinitionName(entry));
  params.set("new", "1");
  return `${path}?${params.toString()}`;
}

function connectionState(connection: ToolConnection): ConnectionState {
  if (isRetiredComposioConnection(connection)) {
    return { kind: "attention", label: "Retired", message: RETIRED_COMPOSIO_MESSAGE };
  }
  if (connection.status === "draft") {
    return {
      kind: "draft",
      label: "Setup incomplete",
      message: "Finish setup before agents can use this account.",
    };
  }
  if (connection.enabled === false || connection.status === "disabled") {
    return {
      kind: "paused",
      label: "Paused",
      message: "This connection is paused. Agents can’t use it until you resume it.",
    };
  }
  if (connection.connectionPurpose === "ai" && connection.healthStatus === "ok" && aiCredentialExpired(connection.config)) {
    return {
      kind: "attention",
      label: "Needs attention",
      message: "The token has expired. Reconnect to restore access.",
    };
  }
  if ((connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config))) || isToolConnectionAttentionHealth(connection.healthStatus)) {
    return {
      kind: "attention",
      label: "Needs attention",
      message:
        connection.healthMessage ??
        connection.lastError ??
        (connection.authKind === "oauth"
          ? "Sign in again to restore access."
          : "Replace the credential to restore access."),
    };
  }
  return { kind: "connected", label: "Connected", message: null };
}

function chatEndpointState(endpoint: ChatEndpoint): ConnectionState {
  switch (endpoint.status) {
    case "draft":
    case "verifying":
      return { kind: "draft", label: "Setup incomplete", message: "Finish setup before this connection receives messages." };
    case "paused":
      return { kind: "paused", label: "Paused", message: "This connection is paused. Resume it to receive new messages." };
    case "revoked":
      return { kind: "attention", label: "Revoked", message: "Access was revoked. Reconnect to restore it." };
    case "attention":
      return {
        kind: "attention",
        label: "Needs attention",
        message: endpoint.healthMessage ?? endpoint.lastError ?? "Reconnect to restore this connection.",
      };
    default:
      return { kind: "connected", label: "Connected", message: null };
  }
}

function connectorAction(
  row: ConnectorRowModel,
  chatConnectorsEnabled: boolean,
  agentId?: string | null,
): {
  label: string;
  href: string | null;
  title?: string;
} {
  const applicationId = row.applications[0]?.id ?? null;
  const chatHref = chatConnectorsEnabled
    ? chatConnectHref(
        row.slug,
        row.entry ? connectHrefFor(row.entry) : null,
        agentId,
      )
    : null;
  if (row.connections.length > 0 || row.chatEndpoints.length > 0) {
    if (chatHref) return { label: "Add connection", href: chatHref };
    if (row.entry && applicationId) {
      return {
        label: "Add account",
        href: additionalConnectionHref(row.entry, applicationId),
      };
    }
    return {
      label: "Add account",
      href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
    };
  }

  if (row.entry?.availability?.available === false) {
    return {
      label: "Unavailable",
      href: null,
      title:
        row.entry.availability.reason ??
        "This connector is unavailable on this instance.",
    };
  }
  if (chatHref) return { label: "Connect", href: chatHref };
  if (row.entry) return { label: "Connect", href: connectHrefFor(row.entry) };
  return {
    label: "Connect",
    href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
  };
}

function accountActionHref(
  row: ConnectorRowModel,
  connection: ToolConnection,
): string {
  if (connection.status === "draft" && row.entry) {
    return appSourceResumeHref(row.slug, connection.id);
  }
  return aiReconnectHref(connection) ?? `/apps/${connection.id}/permissions`;
}

/** Straight to the provider's reconnect step for an AI account (sign in or paste a token). */
function aiReconnectHref(connection: ToolConnection): string | null {
  const ai = connection.connectionPurpose === "ai"
    ? connection.config?.ai as { provider?: string; method?: string } | undefined
    : undefined;
  if (!ai?.provider || !ai.method) return null;
  return `/apps/connect?source=${ai.provider}&reconnect=${connection.id}&method=ai-${ai.method}`;
}

/** OAuth accounts reconnect straight from this page by reopening the provider sign-in. */
function reconnectsWithOAuth(connection: ToolConnection): boolean {
  return connection.authKind === "oauth"
    && connection.connectionPurpose !== "ai"
    && connection.requiresReauthorization !== false
    && connection.credentialSource !== "vercel_connect"
    && !isRetiredComposioConnection(connection);
}

/**
 * The Apps landing page is the single connector catalog and account-management
 * surface. Connected providers sort first and expand in place to show every
 * account; unconnected providers retain the same catalog setup flows.
 */
export function Browse({ renderAccountDetails = (connection) => connection.connectionPurpose === "ai" ? <ManagedAiConnectionRow connection={connection} /> : null }: { renderAccountDetails?: (connection: ToolConnection) => ReactNode } = {}) {
  const navigate = useNavigate();
  const preselectedChatAgentId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("chatAgentId");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  const { enabled: memoryConnectorsEnabled } = useMemoryConnectorsEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [showCatalogue, setShowCatalogue] = useState(false);
  const [connectionToRemove, setConnectionToRemove] =
    useState<ConnectionRemovalTarget | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const chatEndpointsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId ?? "__none__"),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && chatConnectorsEnabled,
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(
      selectedCompanyId ?? "__none__",
    ),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const invalidateConnectors = () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.chatEndpoints.list(selectedCompanyId!),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tools.connections(selectedCompanyId!),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tools.applications(selectedCompanyId!),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.apps.attention(selectedCompanyId!),
    });
  };
  // Same calls the connection detail pages use to resume: no new endpoint.
  const resumeConnection = useMutation({
    mutationFn: async (target: ResumeTarget) => {
      if (target.kind === "chat") {
        await chatEndpointsApi.setup(target.id, { action: "resume" });
      } else {
        await toolsApi.updateConnection(
          target.id,
          target.status === "disabled" ? { enabled: true, status: "active" } : { enabled: true },
        );
      }
    },
    onSuccess: () => {
      invalidateConnectors();
      pushToast({ title: "Connection resumed", tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't resume the connection",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });
  // A test or reconnect that works resumes every task waiting on the connection (GRE-335).
  const testConnection = useMutation({
    mutationFn: (connection: ToolConnection) => toolsApi.checkConnectionHealth(connection.id),
    onSuccess: (result) => {
      invalidateConnectors();
      const badge = connectionHealthBadge(result.connection);
      if (badge.status === "ok" || badge.status === "unchecked") {
        pushToast({ title: "Connection works", tone: "success" });
        return;
      }
      pushToast({
        title: badge.status === "warning" ? "Connection works with warnings" : "Connection still needs reconnecting",
        body: result.connection.healthMessage?.trim() || result.connection.lastError?.trim() || undefined,
        tone: badge.status === "warning" ? "warn" : "error",
      });
    },
    onError: (error) => {
      invalidateConnectors();
      pushToast({
        title: "Connection test failed",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });
  const reconnectOAuth = useMutation({
    mutationFn: (connection: ToolConnection) => startOAuthReconnect(connection),
    onError: (error) =>
      pushToast({
        title: "Couldn’t start sign-in",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });
  const removeConnection = useMutation({
    mutationFn: async (target: ConnectionRemovalTarget) => {
      if (target.kind === "chat") {
        await chatEndpointsApi.setup(target.id, { action: "remove" });
      } else {
        await toolsApi.archiveConnection(target.id);
      }
    },
    onSuccess: (_connection, target) => {
      invalidateConnectors();
      pushToast({
        title: "Connection removed",
        body:
          target.kind === "chat"
            ? `${target.providerName} is disconnected. Existing ${CLIENT_BRAND_NAME} tasks remain available.`
            : target.remainingConnectionCount > 0
            ? `${target.providerName} still has ${target.remainingConnectionCount} active ${target.remainingConnectionCount === 1 ? "connection" : "connections"} available to agents.`
            : `${target.providerName} is no longer available to agents through this connection. Its saved credentials were deleted.`,
        tone: "success",
      });
      setConnectionToRemove(null);
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't remove the connection",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const gallery = (
    (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[]
  ).filter((entry) => {
    if (!memoryConnectorsEnabled && isMemoryConnectorId(appDefinitionSlug(entry))) return false;
    const definition = getAppStoreDefinition(appDefinitionSlug(entry));
    return (
      chatConnectorsEnabled ||
      !definition?.methods.some((method) => method.purpose === "channel") ||
      appSupportsToolCatalogSetup(definition)
    );
  });
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );

  const rows = useMemo<ConnectorRowModel[]>(() => {
    const activeConnections = (connectionsQuery.data?.connections ?? []).filter(
      (connection) =>
        connection.status !== "archived" &&
        connection.connectionPurpose !== "channel",
    );
    const activeApplications = (
      applicationsQuery.data?.applications ?? []
    ).filter(
      (application) =>
        application.status !== "archived" &&
        (chatConnectorsEnabled ||
          (application.type !== "chat" &&
            application.metadata?.purpose !== "channel")),
    );
    const connectionsByApplicationId = new Map<string, ToolConnection[]>();
    for (const connection of activeConnections) {
      connectionsByApplicationId.set(connection.applicationId, [
        ...(connectionsByApplicationId.get(connection.applicationId) ?? []),
        connection,
      ]);
    }

    const gallerySlugs = new Set(
      gallery.map((entry) => appDefinitionSlug(entry)),
    );
    const gallerySlugByName = new Map(
      gallery.map((entry) => [
        appDefinitionName(entry).trim().toLocaleLowerCase(),
        appDefinitionSlug(entry),
      ]),
    );
    const rowsBySlug = new Map<string, ConnectorRowModel>();
    for (const entry of gallery) {
      const slug = appDefinitionSlug(entry);
      rowsBySlug.set(slug, {
        key: `gallery:${slug}`,
        slug,
        name: appDefinitionName(entry),
        description:
          !chatConnectorsEnabled && chatProviderForSlug(slug)
            ? appCopyFor(slug).tagline
            : appDefinitionDescription(entry),
        brandKey: slug,
        logoUrl: appDefinitionLogoUrl(entry),
        darkLogoUrl: appDefinitionDarkLogoUrl(entry),
        entry,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }
    const nativeChatProviders = [
      { provider: "imessage-photon", name: "iMessage Photon", description: "Message agents and share photos from Apple Messages with a dedicated Photon number." },
      {
        provider: "slack",
        name: "Slack",
        description:
          "Chat with agents from Slack channels and direct messages.",
      },
      {
        provider: "github",
        name: "GitHub",
        description:
          "Chat with agents from issues, pull requests, and review threads.",
      },
      {
        provider: "discord",
        name: "Discord",
        description:
          "Chat with agents from Discord channels, threads, and direct messages.",
      },
      {
        provider: "microsoft-teams",
        name: "Microsoft Teams",
        description: "Chat with agents from Teams channels and conversations.",
      },
      {
        provider: "telegram",
        name: "Telegram",
        description:
          "Chat with agents from Telegram direct messages, groups, and topics.",
      },
    ] as const;
    for (const item of chatConnectorsEnabled ? nativeChatProviders : []) {
      if (
        [...rowsBySlug.values()].some(
          (row) => chatProviderForSlug(row.slug) === item.provider,
        )
      )
        continue;
      rowsBySlug.set(item.provider, {
        key: `native-chat:${item.provider}`,
        slug: item.provider,
        name: item.name,
        description: item.description,
        brandKey: item.provider,
        entry: null,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }

    const customRows: ConnectorRowModel[] = [];
    for (const application of activeApplications) {
      const appConnections =
        connectionsByApplicationId.get(application.id) ?? [];
      const configuredConnectionSlug = appConnections
        .map(
          (connection) =>
            connection.config?.sourceTemplateKey ??
            connection.transportConfig?.sourceTemplateKey,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && gallerySlugs.has(value),
        );
      const endpointMatchedSlug = appConnections
        .flatMap((connection) => [
          connection.config?.url,
          connection.transportConfig?.url,
        ])
        .map((value) =>
          typeof value === "string"
            ? appDefinitionSlug(getAppDefinitionForUrl(value, gallery)) || null
            : null,
        )
        .find((value): value is string => Boolean(value));
      const applicationSlug = appApplicationSourceSlug(application);
      const resolvedSlug =
        applicationSlug &&
        applicationSlug !== "link" &&
        gallerySlugs.has(applicationSlug)
          ? applicationSlug
          : (configuredConnectionSlug ??
            endpointMatchedSlug ??
            gallerySlugByName.get(
              application.name.trim().toLocaleLowerCase(),
            ) ??
            null);
      const galleryRow = resolvedSlug ? rowsBySlug.get(resolvedSlug) : null;
      if (galleryRow) {
        galleryRow.applications.push(application);
        galleryRow.connections.push(...appConnections);
        continue;
      }

      customRows.push({
        key: `application:${application.id}`,
        slug: applicationSlug ?? application.id,
        name: application.name,
        description:
          application.description ??
          "A custom connector configured for this organization.",
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
        chatEndpoints: [],
      });
    }

    for (const endpoint of chatConnectorsEnabled
      ? (chatEndpointsQuery.data ?? [])
      : []) {
      if (endpoint.status === "archived") continue;
      let target = [...rowsBySlug.values()].find(
        (row) => chatProviderForSlug(row.slug) === endpoint.provider,
      );
      if (!target) {
        const names = {
          slack: "Slack",
          github: "GitHub",
          discord: "Discord",
          "microsoft-teams": "Microsoft Teams",
          telegram: "Telegram",
          "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
        } as const;
        target = {
          key: `chat:${endpoint.provider}`,
          slug: endpoint.provider,
          name: names[endpoint.provider],
          description: `Chat with agents through ${names[endpoint.provider]}.`,
          brandKey: endpoint.provider,
          entry: null,
          applications: [],
          connections: [],
          chatEndpoints: [],
        };
        customRows.push(target);
      }
      target.chatEndpoints.push(endpoint);
    }

    return [...rowsBySlug.values(), ...customRows]
      .map((row) => ({
        ...row,
        connections: [...row.connections].sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }),
        ),
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }) || left.key.localeCompare(right.key),
      );
  }, [
    applicationsQuery.data,
    chatEndpointsQuery.data,
    chatConnectorsEnabled,
    connectionsQuery.data,
    gallery,
  ]);

  const trimmed = query.trim().toLocaleLowerCase();
  const visibleRows = useMemo(() => {
    if (!trimmed) return rows;
    return rows.filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(trimmed) ||
        row.description.toLocaleLowerCase().includes(trimmed) ||
        row.connections.some((connection) =>
          connection.name.toLocaleLowerCase().includes(trimmed),
        ) ||
        row.chatEndpoints.some((endpoint) =>
          endpoint.assignedAgentName.toLocaleLowerCase().includes(trimmed),
        ),
    );
  }, [rows, trimmed]);
  const showCustomConnector =
    !trimmed || "connect your own tool custom mcp server".includes(trimmed);
  const connectedRows = visibleRows.filter(
    (row) =>
      row.connections.some((connection) => connection.status !== "draft") ||
      row.chatEndpoints.some((endpoint) => !isUnfinishedEndpoint(endpoint)),
  );
  const unfinishedRows = visibleRows.filter(
    (row) =>
      row.connections.some((connection) => connection.status === "draft") ||
      row.chatEndpoints.some(isUnfinishedEndpoint),
  );
  // A provider with only an unfinished setup stays addable, so the owner can
  // start afresh instead of having to finish or delete the draft first.
  const availableRows = visibleRows.filter((row) => !connectedRows.includes(row));
  const hasAccounts = connectedRows.length > 0 || unfinishedRows.length > 0;
  // With nothing connected yet the catalogue is the whole page, so it stays open.
  const catalogueOpen = showCatalogue || !hasAccounts;

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to manage connectors.
      </div>
    );
  }

  const loading =
    galleryQuery.isLoading ||
    applicationsQuery.isLoading ||
    connectionsQuery.isLoading ||
    (chatConnectorsEnabled && chatEndpointsQuery.isLoading);
  const loadFailed =
    galleryQuery.isError ||
    applicationsQuery.isError ||
    connectionsQuery.isError ||
    (chatConnectorsEnabled && chatEndpointsQuery.isError);
  const nothingMatches = visibleRows.length === 0 && !showCustomConnector;

  return (
    <div className="max-w-5xl space-y-5 pb-12">
      <header className="flex justify-start">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.trim()) setShowCatalogue(true);
            }}
            placeholder="Search connectors…"
            aria-label="Search connectors"
            className="pl-9"
          />
        </div>
      </header>

      {loadFailed ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Couldn’t load every connector. Existing accounts are shown where
            available.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void galleryQuery.refetch();
              void applicationsQuery.refetch();
              void connectionsQuery.refetch();
              if (chatConnectorsEnabled) void chatEndpointsQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-3" aria-label="Loading connectors">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches ? (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Link2 className="h-4 w-4" />
          No connectors match “{query.trim()}”.
        </p>
      ) : (
        ([
          ["connected", "Connected", connectedRows],
          ["unfinished", "Not finished", unfinishedRows],
        ] as const).map(([section, title, sectionRows]) =>
          sectionRows.length > 0 ? (
            <section key={section} className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <div className="space-y-3" role="list" aria-label={title}>
                {sectionRows.map((row) => (
                  <ConnectorCard
                    renderAccountDetails={renderAccountDetails}
                    key={row.key}
                    section={section}
                    row={row}
                    userProfileById={userProfileById}
                    onNavigate={navigate}
                    onRequestRemove={setConnectionToRemove}
                    onResume={resumeConnection.mutate}
                    resumingId={resumeConnection.isPending ? (resumeConnection.variables?.id ?? null) : null}
                    onTest={testConnection.mutate}
                    testingId={testConnection.isPending ? (testConnection.variables?.id ?? null) : null}
                    onReconnectOAuth={reconnectOAuth.mutate}
                    reconnectingId={reconnectOAuth.isPending ? (reconnectOAuth.variables?.id ?? null) : null}
                    preselectedAgentId={preselectedChatAgentId}
                    chatConnectorsEnabled={chatConnectorsEnabled}
                  />
                ))}
              </div>
            </section>
          ) : null,
        )
      )}

      {!loading && !nothingMatches ? (
        <section className="space-y-3">
          {hasAccounts ? (
            <Button
              type="button"
              variant="outline"
              aria-expanded={catalogueOpen}
              aria-controls="connector-catalogue"
              onClick={() => setShowCatalogue((open) => !open)}
            >
              <Plus />
              Add a connector
            </Button>
          ) : null}
          {catalogueOpen ? (
            <div
              id="connector-catalogue"
              className="space-y-3"
              role="list"
              aria-label="Available connectors"
            >
              {availableRows.map((row) => (
                <ConnectorCard
                  key={row.key}
                  section="available"
                  row={row}
                  userProfileById={userProfileById}
                  onNavigate={navigate}
                  onRequestRemove={setConnectionToRemove}
                  preselectedAgentId={preselectedChatAgentId}
                  chatConnectorsEnabled={chatConnectorsEnabled}
                />
              ))}
              {showCustomConnector ? (
                <CustomConnectorCard onNavigate={navigate} />
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <AlertDialog
        open={connectionToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removeConnection.isPending) setConnectionToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {connectionToRemove?.accountName ?? "this"} connection?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove?.kind === "chat"
                ? `This connection will stop receiving new work from ${connectionToRemove.providerName}. Existing ${CLIENT_BRAND_NAME} tasks and conversation history remain available. This does not delete the app, bot, or account in ${connectionToRemove.providerName}.`
                : connectionToRemove &&
                    connectionToRemove.remainingConnectionCount > 0
                  ? `This connection's saved credentials are deleted and agents lose access through it immediately. They can still use ${connectionToRemove.providerName} through ${connectionToRemove.remainingConnectionCount} other active ${connectionToRemove.remainingConnectionCount === 1 ? "connection" : "connections"}.`
                  : "The saved credentials are deleted and agents lose access immediately. Connecting it again later requires a new sign-in or key."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeConnection.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToRemove || removeConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToRemove)
                  removeConnection.mutate(connectionToRemove);
              }}
            >
              {removeConnection.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 />
              )}
              {removeConnection.isPending ? "Removing…" : "Remove connection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ConnectorCard({
  renderAccountDetails,
  section = "connected",
  row,
  userProfileById,
  onNavigate,
  onRequestRemove,
  onResume,
  resumingId = null,
  onTest,
  testingId = null,
  onReconnectOAuth,
  reconnectingId = null,
  preselectedAgentId,
  chatConnectorsEnabled,
}: {
  renderAccountDetails?: (connection: ToolConnection) => ReactNode;
  section?: CardSection;
  row: ConnectorRowModel;
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
  onResume?: (target: ResumeTarget) => void;
  resumingId?: string | null;
  onTest?: (connection: ToolConnection) => void;
  testingId?: string | null;
  onReconnectOAuth?: (connection: ToolConnection) => void;
  reconnectingId?: string | null;
  preselectedAgentId?: string | null;
  chatConnectorsEnabled: boolean;
}) {
  const action = connectorAction(
    row,
    chatConnectorsEnabled,
    preselectedAgentId,
  );
  const unfinished = section === "unfinished";
  const connections = row.connections.filter(
    (connection) => (connection.status === "draft") === unfinished,
  );
  const chatEndpoints = row.chatEndpoints.filter(
    (endpoint) => isUnfinishedEndpoint(endpoint) === unfinished,
  );
  return (
    <div
      role="listitem"
      data-app-slug={row.slug}
      data-connected={
        row.connections.length > 0 || row.chatEndpoints.length > 0
          ? "true"
          : "false"
      }
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AppLogo
            name={row.name}
            brandKey={row.brandKey}
            logoUrl={row.logoUrl}
            darkLogoUrl={row.darkLogoUrl}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">{row.name}</h3>
            {unfinished ? null : (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.description}
              </p>
            )}
          </div>
        </div>
        {unfinished ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-12 self-start sm:ml-0 sm:self-auto"
            disabled={!action.href}
            title={action.title}
            onClick={() => {
              if (action.href) onNavigate(action.href);
            }}
            aria-label={`${action.label} ${row.name}`}
          >
            {action.label}
          </Button>
        )}
      </div>

      {connections.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {connections.map((connection) => (
            <ConnectionAccountRow
              details={renderAccountDetails?.(connection)}
              key={connection.id}
              row={row}
              connection={connection}
              owner={connectionOwnerProfile(connection, userProfileById)}
              onNavigate={onNavigate}
              resuming={resumingId === connection.id}
              onTest={onTest ? () => onTest(connection) : undefined}
              testing={testingId === connection.id}
              onReconnectOAuth={onReconnectOAuth ? () => onReconnectOAuth(connection) : undefined}
              reconnecting={reconnectingId === connection.id}
              onResume={
                onResume
                  ? () => onResume({ kind: "tool", id: connection.id, status: connection.status })
                  : undefined
              }
              onRemove={() => {
                const accountName = connectionDisplayNameForOwner(
                  connection,
                  row.name,
                  connectionOwnerProfile(connection, userProfileById),
                );
                onRequestRemove({
                  id: connection.id,
                  accountName,
                  providerName: row.name,
                  remainingConnectionCount: row.connections.filter(
                    (candidate) =>
                      candidate.id !== connection.id &&
                      candidate.status === "active" &&
                      candidate.enabled,
                  ).length,
                });
              }}
            />
          ))}
        </div>
      ) : null}
      {chatEndpoints.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {chatEndpoints.map((endpoint) => {
            const state = chatEndpointState(endpoint);
            const setupHref = `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`;
            return (
            <div
              key={endpoint.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <ConnectionStatusIcon state={state} />
                <div className="min-w-0">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                    onClick={() =>
                      onNavigate(`/apps/chat/${endpoint.id}/settings`)
                    }
                  >
                    {endpoint.assignedAgentName} · {endpoint.provider === "agentmail" ? "Email" : "Chat"}
                  </button>
                  <p className="truncate text-xs text-muted-foreground">
                    {endpoint.providerAccountLabel ??
                      endpoint.botLabel ??
                      "Provider identity"}
                  </p>
                  <ConnectionStateMessage state={state} />
                </div>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                {state.kind === "draft" || state.kind === "attention" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onNavigate(state.kind === "draft" ? setupHref : `${setupHref}&reconnect=1`)
                    }
                  >
                    {state.kind === "draft" ? "Finish setup" : "Reconnect"}
                  </Button>
                ) : null}
                {state.kind === "paused" && onResume ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resumingId === endpoint.id}
                    onClick={() => onResume({ kind: "chat", id: endpoint.id })}
                  >
                    Resume
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Manage ${endpoint.assignedAgentName} ${row.name} connection`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onNavigate(`/apps/chat/${endpoint.id}/settings`)}>
                      Manage
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onRequestRemove({
                        kind: "chat",
                        id: endpoint.id,
                        accountName: `${endpoint.assignedAgentName} · ${row.name}`,
                        providerName: row.name,
                        remainingConnectionCount: 0,
                      })}
                    >
                      <Trash2 />
                      Remove connection
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionAccountRow({
  details,
  row,
  connection,
  owner,
  onNavigate,
  onRemove,
  onResume,
  resuming,
  onTest,
  testing = false,
  onReconnectOAuth,
  reconnecting = false,
}: {
  details?: ReactNode;
  row: ConnectorRowModel;
  connection: ToolConnection;
  owner: ConnectionOwnerProfile | null;
  onNavigate: (href: string) => void;
  onRemove: () => void;
  onResume?: () => void;
  resuming: boolean;
  onTest?: () => void;
  testing?: boolean;
  onReconnectOAuth?: () => void;
  reconnecting?: boolean;
}) {
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const reconnectHref = aiReconnectHref(connection);
  const oauthReconnect = onReconnectOAuth && reconnectsWithOAuth(connection) ? onReconnectOAuth : null;
  const live = state.kind === "connected" || state.kind === "attention";
  const retired = isRetiredComposioConnection(connection);
  const health = live && !retired
    ? connectionHealthBadge(connection, state.kind === "attention")
    : null;
  const lastError = health && health.status !== "ok"
    ? connection.lastError?.trim() || null
    : null;
  const accountName = connectionDisplayNameForOwner(
    connection,
    row.name,
    owner,
  );

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <ConnectionStatusIcon state={state} />
        <div className="min-w-0">
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline"
            aria-label={`Open ${accountName} permissions`}
            onClick={() => onNavigate(`/apps/${connection.id}/permissions`)}
          >
            {accountName}
          </button>
          {health ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusBadge status={health.status} label={health.label} />
              <span>{connectionCheckedLabel(connection)}</span>
            </div>
          ) : null}
          {details}
          <ConnectionStateMessage state={state} />
          {lastError && lastError !== state.message ? (
            <div title={lastError} className="line-clamp-2 break-all text-xs text-muted-foreground">
              Last error: {lastError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {/* On a phone, give the owner its own line so an action and the menu stay together. */}
        <div
          className={`flex items-center gap-1.5 text-xs text-muted-foreground${
            state.kind === "connected" ? "" : " basis-full sm:basis-auto"
          }`}
        >
          <span>Connected by</span>
          <ConnectionOwnerIdentity owner={owner} />
        </div>
        {state.kind === "attention" || state.kind === "draft" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={state.kind === "attention" && reconnecting}
            onClick={() => {
              if (state.kind === "attention" && oauthReconnect) oauthReconnect();
              else onNavigate(actionHref);
            }}
          >
            {state.kind === "attention" && reconnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {state.kind === "attention"
              ? connection.requiresReauthorization === false
                ? "Retry access"
                : reconnecting
                  ? "Opening sign-in…"
                  : "Reconnect"
              : "Finish setup"}
          </Button>
        ) : null}
        {health && onTest ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing}
            onClick={onTest}
            aria-label={`Test ${accountName} connection`}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Stethoscope aria-hidden="true" />
            )}
            {testing ? "Testing…" : "Test"}
          </Button>
        ) : null}
        {state.kind === "paused" && onResume ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={resuming}
            onClick={onResume}
          >
            Resume
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Manage ${accountName} connection`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onNavigate(`/apps/${connection.id}/permissions`)}
            >
              Permissions
            </DropdownMenuItem>
            {reconnectHref ? (
              <DropdownMenuItem onSelect={() => onNavigate(reconnectHref)}>
                Reconnect
              </DropdownMenuItem>
            ) : oauthReconnect && state.kind === "connected" ? (
              <DropdownMenuItem disabled={reconnecting} onSelect={oauthReconnect}>
                Reconnect
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove connection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** The short reason a connection is not usable; wraps on a phone rather than cutting off. */
function ConnectionStateMessage({ state }: { state: ConnectionState }) {
  if (!state.message) return null;
  return (
    <div
      title={state.message}
      className={
        state.kind === "attention"
          ? "line-clamp-2 text-xs text-destructive"
          : "line-clamp-2 text-xs text-muted-foreground"
      }
    >
      {state.message}
    </div>
  );
}

function ConnectionStatusIcon({ state }: { state: ConnectionState }) {
  if (state.kind === "connected") {
    return (
      <span
        className="mt-0.5 text-emerald-600 dark:text-emerald-400"
        title={state.label}
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "attention") {
    return (
      <span className="mt-0.5 text-destructive" title={state.label}>
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "draft") {
    return (
      <span
        className="mt-0.5 text-amber-600 dark:text-amber-400"
        title={state.label}
      >
        <Clock3 className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 text-muted-foreground" title={state.label}>
      <PauseCircle className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{state.label}</span>
    </span>
  );
}

function CustomConnectorCard({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="listitem"
      data-app-slug="custom-mcp"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Link2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">
              Connect your own tool
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add a custom MCP server or paste an existing configuration.
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-12 self-start sm:ml-0 sm:self-auto"
          aria-expanded={expanded}
          aria-controls="custom-connector-options"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Close" : "Connect"}
        </Button>
      </div>

      {expanded ? (
        <div
          id="custom-connector-options"
          className="grid gap-2 border-t border-border px-4 py-3 sm:grid-cols-2"
        >
          <CustomConnectorOption
            icon={ServerCog}
            title="Connect your own MCP server"
            description="Enter the URL for a custom or self-hosted MCP server."
            onClick={() => onNavigate("/apps/byo")}
          />
          <CustomConnectorOption
            icon={ClipboardPaste}
            title="Paste a config"
            description="Paste an existing setup snippet and connect it."
            onClick={() => onNavigate("/apps/advanced/paste-config")}
          />
        </div>
      ) : null}
    </div>
  );
}

function CustomConnectorOption({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof ServerCog;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
      onClick={onClick}
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
