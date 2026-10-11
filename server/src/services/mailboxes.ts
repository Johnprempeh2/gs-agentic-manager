import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import {
  type Db,
  agents,
  issues,
  toolConnections,
  toolConnectionInstalls,
} from "@greatstone/db";
import type {
  MailboxAddress,
  MailboxAgentsInput,
  MailboxConnectInput,
  MailboxMessage,
  MailboxOAuthAppInput,
  MailboxOAuthAppSummary,
  MailboxOAuthProvider,
  MailboxOAuthStartInput,
  MailboxReadInput,
  MailboxSaveInput,
  MailboxSearchInput,
  MailboxSummary,
} from "@greatstone/shared";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
} from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import {
  imapMailboxClient,
  MailboxAuthError,
  type MailboxAccount,
  type MailboxClientFactory,
} from "./mailbox-imap.js";
import {
  accessTokenFor,
  addressFromIdToken,
  authorizationUrl,
  forgetAccessToken,
  MAILBOX_OAUTH_PROVIDERS,
  parseApp,
  pkcePair,
  primeAccessToken,
  rememberSignIn,
  requestToken,
  takeSignIn,
  type MailboxOAuthApp,
  type OAuthFetch,
  type PendingSignIn,
} from "./mailbox-oauth.js";

export const MAILBOX_PROVIDER = "imap_mailbox";
const PASSWORD_PATH = "credentials.password";
const REFRESH_TOKEN_PATH = "credentials.refreshToken";
const OAUTH_APP_PATH = "credentials.clientSecret";
const MAX_TEXT_CHARS = 100_000;

type Connection = typeof toolConnections.$inferSelect;
type MailboxConfig = {
  provider: typeof MAILBOX_PROVIDER;
  label: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Set for Microsoft / Google sign-in; absent for an IMAP app password. */
  oauthProvider?: MailboxOAuthProvider;
};
export type MailboxBoardActor = { userId?: string; localImplicit?: boolean };
/** Who is reading. Agents only reach mailboxes installed for them. */
export type MailboxReader =
  | { kind: "board"; userId?: string }
  | { kind: "agent"; agentId: string; runId?: string };

function boardActor(actor: MailboxBoardActor) {
  return {
    actorType: "user" as const,
    actorId: actor.userId ?? "board",
    actorSource: actor.localImplicit ? ("local_implicit" as const) : ("session" as const),
  };
}

function safeFilename(name: string, fallback: string) {
  const cleaned = name
    .replace(/[\/\\\u0000-\u001f]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[_\s]+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): MailboxAddress[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  return groups.flatMap((group) =>
    group.value.map((entry) => ({
      name: entry.name || null,
      address: entry.address || null,
    })),
  );
}

function appKey(provider: MailboxOAuthProvider) {
  return `mailbox_oauth.${provider}.app`;
}

export function mailboxService(
  db: Db,
  options: {
    clientFactory?: MailboxClientFactory;
    storage?: StorageService;
    fetch?: OAuthFetch;
  } = {},
) {
  const clientFactory = options.clientFactory ?? imapMailboxClient;
  const oauthFetch: OAuthFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const secrets = secretService(db);

  async function rows(companyId: string) {
    return db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.status, "active"),
          eq(toolConnections.enabled, true),
          sql`${toolConnections.config}->>'provider' = ${MAILBOX_PROVIDER}`,
        ),
      );
  }

  async function installsFor(companyId: string, connectionIds: string[]) {
    if (!connectionIds.length) return [];
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.companyId, companyId));
    return installs.filter((install) => connectionIds.includes(install.connectionId));
  }

  function toSummary(
    connection: Connection,
    installs: Array<typeof toolConnectionInstalls.$inferSelect>,
  ): MailboxSummary {
    const config = connection.config as unknown as MailboxConfig;
    const own = installs.filter((install) => install.connectionId === connection.id);
    return {
      id: connection.id,
      label: config.label,
      address: config.address,
      host: config.host,
      port: config.port,
      secure: config.secure,
      username: config.username,
      provider: config.oauthProvider ?? "imap",
      healthStatus: connection.healthStatus ?? "unknown",
      healthMessage: connection.healthMessage ?? null,
      healthCheckedAt: connection.healthCheckedAt?.toISOString() ?? null,
      allAgents: own.some((install) => install.targetType === "company"),
      agentIds: own
        .filter((install) => install.targetType === "agent")
        .map((install) => install.targetId),
      createdAt: connection.createdAt.toISOString(),
    };
  }

  async function list(companyId: string): Promise<MailboxSummary[]> {
    const connections = await rows(companyId);
    const installs = await installsFor(companyId, connections.map((c) => c.id));
    return connections
      .map((connection) => toSummary(connection, installs))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async function assigned(companyId: string, agentId: string) {
    return (await list(companyId)).filter(
      (mailbox) => mailbox.allAgents || mailbox.agentIds.includes(agentId),
    );
  }

  async function get(companyId: string, id: string, reader?: MailboxReader) {
    const [connection] = (await rows(companyId)).filter((row) => row.id === id);
    if (!connection) throw notFound("Mailbox not found");
    if (reader?.kind === "agent") {
      const installs = await installsFor(companyId, [id]);
      const allowed = installs.some(
        (install) =>
          install.targetType === "company" ||
          (install.targetType === "agent" && install.targetId === reader.agentId),
      );
      // Same answer as a missing mailbox: do not confirm another agent's mailbox.
      if (!allowed) throw notFound("Mailbox not found");
    }
    return connection;
  }

  async function credential(connection: Connection, configPath: string) {
    const ref = connection.credentialSecretRefs.find((r) => r.configPath === configPath);
    if (!ref) throw new MailboxAuthError("This mailbox has no saved sign-in. Reconnect it.");
    const value = await secrets.resolveSecretValue(
      connection.companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: connection.id,
        configPath,
        actorType: "system",
        actorId: null,
      },
    );
    return { secretId: ref.secretId, value };
  }

  async function loadApp(companyId: string, provider: MailboxOAuthProvider) {
    const secret = await secrets.getByKey(companyId, appKey(provider));
    if (!secret || secret.status !== "active") return null;
    const raw = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: appKey(provider),
        configPath: OAUTH_APP_PATH,
        actorType: "system",
        actorId: null,
      },
    });
    return { secretId: secret.id, app: parseApp(raw) };
  }

  async function requireApp(companyId: string, provider: MailboxOAuthProvider) {
    const found = await loadApp(companyId, provider);
    if (!found)
      throw new MailboxAuthError(
        `Add the ${MAILBOX_OAUTH_PROVIDERS[provider].label} app settings on the Mailboxes page, then reconnect.`,
      );
    return found.app;
  }

  /** Redeem the stored refresh token. Microsoft may hand back a new one. */
  async function refresh(connection: Connection, provider: MailboxOAuthProvider) {
    const app = await requireApp(connection.companyId, provider);
    const stored = await credential(connection, REFRESH_TOKEN_PATH);
    const tokens = await requestToken(oauthFetch, provider, app, {
      grant_type: "refresh_token",
      refresh_token: stored.value,
    });
    if (tokens.refreshToken && tokens.refreshToken !== stored.value)
      await secrets.rotate(stored.secretId, { value: tokens.refreshToken });
    return tokens;
  }

  async function account(connection: Connection): Promise<MailboxAccount> {
    const config = connection.config as unknown as MailboxConfig;
    const server = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      username: config.username,
    };
    const provider = config.oauthProvider;
    if (provider) {
      const accessToken = await accessTokenFor(connection.id, () => refresh(connection, provider));
      return { ...server, accessToken };
    }
    return { ...server, password: (await credential(connection, PASSWORD_PATH)).value };
  }

  async function setHealth(connection: Connection, ok: boolean, message: string) {
    await db
      .update(toolConnections)
      .set({
        healthStatus: ok ? "ok" : "failed",
        healthMessage: message,
        healthCheckedAt: new Date(),
        lastError: ok ? null : message,
      })
      .where(eq(toolConnections.id, connection.id));
  }

  /** Run one IMAP call. A sign-in failure marks the mailbox for reconnecting. */
  async function withClient<T>(
    connection: Connection,
    work: (client: ReturnType<MailboxClientFactory>) => Promise<T>,
  ) {
    try {
      const first = await account(connection);
      try {
        return await work(clientFactory(first));
      } catch (error) {
        // A cached access token can be revoked before it expires. Retry once
        // with a freshly refreshed one; a second refusal is final.
        if (!(error instanceof MailboxAuthError) || !first.accessToken) throw error;
        forgetAccessToken(connection.id);
        return await work(clientFactory(await account(connection)));
      }
    } catch (error) {
      if (error instanceof MailboxAuthError)
        await setHealth(connection, false, error.message);
      throw error;
    }
  }

  async function assertAgents(companyId: string, agentIds: string[]) {
    for (const agentId of agentIds) {
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
          ),
        );
      if (!agent) throw badRequest("Select an available company agent");
    }
  }

  function installTargets(companyId: string, input: MailboxAgentsInput) {
    return input.allAgents
      ? [{ targetType: "company" as const, targetId: companyId }]
      : [...new Set(input.agentIds)].map((targetId) => ({
          targetType: "agent" as const,
          targetId,
        }));
  }

  /**
   * Store a signed-in mailbox: its credential as an owned secret, the tool
   * connection, and the agent installs, in one transaction.
   */
  async function createMailbox(
    companyId: string,
    input: {
      key: string;
      config: MailboxConfig;
      secretPath: string;
      secretValue: string;
      secretDescription: string;
      allAgents: boolean;
      agentIds: string[];
    },
    actor: MailboxBoardActor,
  ) {
    const uid = `mailbox-${input.key}`;
    const id = await db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox:${companyId}:${input.key}`}, 0))`,
      );
      const [previous] = await db
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, uid)));
      if (previous) return previous.id;
      const secret = await secretService(db).create(companyId, {
        name: `Mailbox ${input.secretPath === PASSWORD_PATH ? "password" : "sign-in"} ${input.config.address} ${randomUUID().slice(0, 8)}`,
        // The `tool_app.` namespace marks the secret as owned by this
        // connection, so removing the mailbox revokes it.
        key: `tool_app.${randomUUID()}.${input.secretPath.replace(".", "_")}`,
        provider: "local_encrypted",
        value: input.secretValue,
        description: input.secretDescription,
      });
      const tools = toolAccessService(db);
      const app = await tools.createApplication(companyId, {
        name: `Mailbox ${input.config.address}`.slice(0, 200),
        applicationKey: `mailbox:${input.key}`,
        type: "chat",
        status: "active",
        metadata: { sourceTemplateKey: MAILBOX_PROVIDER },
      });
      const connection = await tools.createConnection(
        companyId,
        {
          applicationId: app.id,
          name: input.config.label,
          connectionKind: "managed",
          connectionPurpose: "tool",
          transport: "rest_api",
          authKind: "api_key",
          ownership: "customer",
          credentialPolicy: "shared",
          enabled: true,
          status: "active",
          config: input.config,
          transportConfig: {},
          credentialSecretRefs: [
            {
              secretId: secret.id,
              configPath: input.secretPath,
              versionSelector: "latest",
              required: true,
            },
          ],
        },
        boardActor(actor),
      );
      await db
        .update(toolConnections)
        .set({
          uid,
          healthStatus: "ok",
          healthMessage: "Connected",
          healthCheckedAt: new Date(),
        })
        .where(eq(toolConnections.id, connection.id));
      await tools.putConnectionInstalls(
        connection.id,
        { installs: installTargets(companyId, input) },
        boardActor(actor),
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "mailbox.connected",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          address: input.config.address,
          host: input.config.host,
          ...(input.config.oauthProvider ? { provider: input.config.oauthProvider } : {}),
          allAgents: input.allAgents,
          agentIds: input.agentIds,
        },
      });
      return connection.id;
    });
    const created = (await list(companyId)).find((m) => m.id === id);
    if (!created) throw notFound("Mailbox not found");
    return created;
  }

  async function connect(
    companyId: string,
    input: MailboxConnectInput,
    actor: MailboxBoardActor,
  ): Promise<MailboxSummary> {
    await assertAgents(companyId, input.agentIds);
    const uid = `mailbox-${input.idempotencyKey}`;
    const [existing] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, uid)));
    if (existing) return (await list(companyId)).find((m) => m.id === existing.id) ?? toSummary(existing, []);
    // Sign in before saving anything, so a typo never becomes a stored secret.
    await clientFactory({
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      password: input.password,
    }).folders();
    return createMailbox(
      companyId,
      {
        key: input.idempotencyKey,
        config: {
          provider: MAILBOX_PROVIDER,
          label: input.label,
          address: input.address,
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
        },
        secretPath: PASSWORD_PATH,
        secretValue: input.password,
        secretDescription: `IMAP app password for ${input.address}.`,
        allAgents: input.allAgents,
        agentIds: input.agentIds,
      },
      actor,
    );
  }

  async function oauthApps(companyId: string, redirectUri: string): Promise<MailboxOAuthAppSummary[]> {
    const providers: MailboxOAuthProvider[] = ["microsoft", "google"];
    return Promise.all(
      providers.map(async (provider) => {
        const found = await loadApp(companyId, provider).catch(() => null);
        return {
          provider,
          configured: !!found,
          clientId: found?.app.clientId ?? null,
          tenant: provider === "microsoft" ? (found?.app.tenant ?? null) : null,
          redirectUri,
        };
      }),
    );
  }

  async function saveOAuthApp(
    companyId: string,
    provider: MailboxOAuthProvider,
    input: MailboxOAuthAppInput,
    actor: MailboxBoardActor,
  ) {
    const app: MailboxOAuthApp = {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(provider === "microsoft" && input.tenant ? { tenant: input.tenant } : {}),
    };
    const value = JSON.stringify(app);
    const existing = await secrets.getByKey(companyId, appKey(provider));
    if (existing && existing.status === "active") {
      await secrets.rotate(existing.id, { value }, { userId: actor.userId ?? null });
    } else {
      await secrets.create(
        companyId,
        {
          name: `Mailbox sign-in app (${MAILBOX_OAUTH_PROVIDERS[provider].label})`,
          key: appKey(provider),
          provider: "local_encrypted",
          value,
          description: `OAuth client for ${MAILBOX_OAUTH_PROVIDERS[provider].label} mailbox sign-in.`,
        },
        { userId: actor.userId ?? null },
      );
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mailbox.oauth_app_saved",
      entityType: "company",
      entityId: companyId,
      details: { provider, clientId: app.clientId, tenant: app.tenant ?? null },
    });
    return { provider, configured: true, clientId: app.clientId, tenant: app.tenant ?? null };
  }

  async function startOAuth(
    companyId: string,
    input: MailboxOAuthStartInput,
    actor: MailboxBoardActor,
    redirectUri: string,
  ) {
    await assertAgents(companyId, input.agentIds);
    const found = await loadApp(companyId, input.provider);
    if (!found)
      throw unprocessable(
        `Add the ${MAILBOX_OAUTH_PROVIDERS[input.provider].label} app settings first.`,
        { code: "mailbox_oauth_app_missing" },
      );
    const pkce = pkcePair();
    const state = rememberSignIn({
      companyId,
      provider: input.provider,
      userId: actor.userId ?? "board",
      codeVerifier: pkce.verifier,
      redirectUri,
      label: input.label || undefined,
      allAgents: input.allAgents,
      agentIds: input.agentIds,
    });
    return {
      authorizationUrl: authorizationUrl({
        provider: input.provider,
        app: found.app,
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
      }),
    };
  }

  /**
   * Finish a sign-in: redeem the code, confirm IMAP accepts the token, then
   * store the refresh token. Signing in again to a mailbox that is already
   * linked replaces its refresh token (the "Reconnect" path).
   */
  async function completeOAuth(
    entry: PendingSignIn,
    code: string,
    actor: MailboxBoardActor,
  ): Promise<MailboxSummary> {
    const { companyId, provider } = entry;
    const label = MAILBOX_OAUTH_PROVIDERS[provider].label;
    const app = await requireApp(companyId, provider);
    const tokens = await requestToken(oauthFetch, provider, app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: entry.redirectUri,
      code_verifier: entry.codeVerifier,
    });
    const address = addressFromIdToken(tokens.idToken);
    if (!address) throw unprocessable(`${label} did not say which mailbox signed in. Try again.`);
    if (!tokens.refreshToken)
      throw unprocessable(`${label} did not allow offline access. Sign in again and accept every permission.`);
    const server = {
      host: MAILBOX_OAUTH_PROVIDERS[provider].imapHost,
      port: 993,
      secure: true,
      username: address,
    };
    await clientFactory({ ...server, accessToken: tokens.accessToken }).folders();

    const existing = (await rows(companyId)).find((row) => {
      const config = row.config as unknown as MailboxConfig;
      return config.oauthProvider === provider && config.address === address;
    });
    if (existing) {
      const ref = existing.credentialSecretRefs.find((r) => r.configPath === REFRESH_TOKEN_PATH);
      if (ref) {
        await secrets.rotate(ref.secretId, { value: tokens.refreshToken }, { userId: actor.userId ?? null });
        primeAccessToken(existing.id, tokens);
        await setHealth(existing, true, "Connected");
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actor.userId ?? "board",
          action: "mailbox.reconnected",
          entityType: "tool_connection",
          entityId: existing.id,
          details: { address, provider },
        });
        return (await list(companyId)).find((m) => m.id === existing.id)!;
      }
    }

    await assertAgents(companyId, entry.agentIds);
    const created = await createMailbox(
      companyId,
      {
        key: `oauth-${randomUUID()}`,
        config: {
          provider: MAILBOX_PROVIDER,
          label: entry.label || address,
          address,
          ...server,
          oauthProvider: provider,
        },
        secretPath: REFRESH_TOKEN_PATH,
        secretValue: tokens.refreshToken,
        secretDescription: `${label} sign-in (refresh token) for ${address}.`,
        allAgents: entry.allAgents,
        agentIds: entry.agentIds,
      },
      actor,
    );
    primeAccessToken(created.id, tokens);
    return created;
  }

  async function setAgents(
    companyId: string,
    id: string,
    input: MailboxAgentsInput,
    actor: MailboxBoardActor,
  ) {
    await get(companyId, id);
    await assertAgents(companyId, input.agentIds);
    await toolAccessService(db).putConnectionInstalls(
      id,
      { installs: installTargets(companyId, input) },
      boardActor(actor),
    );
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mailbox.agents_updated",
      entityType: "tool_connection",
      entityId: id,
      details: { allAgents: input.allAgents, agentIds: input.agentIds },
    });
    return (await list(companyId)).find((m) => m.id === id)!;
  }

  async function remove(companyId: string, id: string, actor: MailboxBoardActor) {
    await get(companyId, id);
    await toolAccessService(db).archiveConnection(id, companyId, boardActor(actor));
    forgetAccessToken(id);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mailbox.removed",
      entityType: "tool_connection",
      entityId: id,
      details: {},
    });
    return { id, removed: true };
  }

  async function test(companyId: string, id: string) {
    const connection = await get(companyId, id);
    const folders = await withClient(connection, (client) => client.folders());
    await setHealth(connection, true, "Connected");
    return { ok: true, folderCount: folders.length };
  }

  async function folders(companyId: string, id: string, reader: MailboxReader) {
    const connection = await get(companyId, id, reader);
    return withClient(connection, (client) => client.folders());
  }

  async function search(
    companyId: string,
    id: string,
    query: MailboxSearchInput,
    reader: MailboxReader,
  ) {
    if (query.since && query.before && query.since >= query.before)
      throw badRequest("`since` must be before `before`");
    const connection = await get(companyId, id, reader);
    return withClient(connection, (client) => client.search(query));
  }

  async function source(connection: Connection, folder: string, uid: number) {
    const raw = await withClient(connection, (client) => client.source(folder, uid));
    if (!raw) throw notFound("Message not found in this folder");
    return raw;
  }

  async function read(
    companyId: string,
    id: string,
    input: MailboxReadInput,
    reader: MailboxReader,
  ): Promise<MailboxMessage> {
    const connection = await get(companyId, id, reader);
    const raw = await source(connection, input.folder, input.uid);
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const text = parsed.text ?? "";
    return {
      uid: input.uid,
      folder: input.folder,
      messageId: parsed.messageId ?? null,
      subject: parsed.subject ?? null,
      from: parsedAddresses(parsed.from),
      to: parsedAddresses(parsed.to),
      cc: parsedAddresses(parsed.cc),
      date: parsed.date ? parsed.date.toISOString() : null,
      size: raw.length,
      text: text.slice(0, MAX_TEXT_CHARS),
      textTruncated: text.length > MAX_TEXT_CHARS,
      attachments: parsed.attachments.map((attachment, index) => ({
        index,
        filename: attachment.filename ?? `attachment-${index + 1}`,
        contentType: normalizeContentType(attachment.contentType),
        size: attachment.size,
      })),
      untrustedContent: true,
    };
  }

  async function save(
    companyId: string,
    id: string,
    input: MailboxSaveInput,
    reader: MailboxReader,
  ) {
    if (!options.storage) throw new Error("Mailbox save needs file storage");
    const [issue] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, input.issueId));
    if (!issue || issue.companyId !== companyId) throw notFound("Task not found");
    if (reader.kind === "agent" && issue.assigneeAgentId !== reader.agentId)
      throw forbidden("Save email only to a task assigned to you");
    const connection = await get(companyId, id, reader);
    const raw = await source(connection, input.folder, input.uid);
    let body: Buffer;
    let filename: string;
    let contentType: string;
    if (input.attachmentIndex === undefined) {
      const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true });
      body = raw;
      filename = `${safeFilename(parsed.subject ?? "", "email")}.eml`;
      // Served as a download (not inline), so a crafted message cannot render.
      contentType = "message/rfc822";
    } else {
      const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true });
      const attachment = parsed.attachments[input.attachmentIndex];
      if (!attachment) throw notFound("Attachment not found in this message");
      contentType = normalizeContentType(attachment.contentType);
      if (!isAllowedContentType(contentType))
        throw unprocessable(
          `Attachments of type ${contentType} cannot be saved to a task. Save the whole email as .eml instead.`,
        );
      body = attachment.content;
      filename = safeFilename(attachment.filename ?? "", `attachment-${input.attachmentIndex + 1}`);
    }
    if (body.length > MAX_ATTACHMENT_BYTES)
      throw unprocessable("This file is larger than the task attachment limit");
    const stored = await options.storage.putFile({
      companyId,
      namespace: `issues/${issue.id}`,
      originalFilename: filename,
      contentType,
      body,
    });
    const attachment = await issueService(db).createAttachment({
      issueId: issue.id,
      ...stored,
      createdByAgentId: reader.kind === "agent" ? reader.agentId : null,
      createdByUserId: reader.kind === "board" ? (reader.userId ?? null) : null,
      createdByRunId: reader.kind === "agent" ? (reader.runId ?? null) : null,
    });
    await logActivity(db, {
      companyId,
      actorType: reader.kind === "agent" ? "agent" : "user",
      actorId: reader.kind === "agent" ? reader.agentId : (reader.userId ?? "board"),
      agentId: reader.kind === "agent" ? reader.agentId : null,
      runId: reader.kind === "agent" ? (reader.runId ?? null) : null,
      action: "mailbox.message_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        mailboxId: id,
        folder: input.folder,
        uid: input.uid,
        attachmentId: attachment.id,
        kind: input.attachmentIndex === undefined ? "eml" : "attachment",
      },
    });
    return {
      attachmentId: attachment.id,
      issueId: issue.id,
      filename,
      contentType,
      byteSize: stored.byteSize,
    };
  }

  return {
    list,
    assigned,
    connect,
    oauthApps,
    saveOAuthApp,
    startOAuth,
    takeSignIn,
    completeOAuth,
    setAgents,
    remove,
    test,
    folders,
    search,
    read,
    save,
  };
}

export type MailboxService = ReturnType<typeof mailboxService>;
