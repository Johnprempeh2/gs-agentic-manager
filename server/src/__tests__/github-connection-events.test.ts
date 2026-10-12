import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import { eq } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  PaperclipCloudConnectorError,
  type PaperclipCloudConnector,
} from "../services/paperclip-cloud-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("GitHub connection event delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionEventDeliveries);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies a normalized merged PR once, updates the snapshot, and acknowledges Cloud", async () => {
    const companyId = randomUUID();
    const userId = `github-owner-${randomUUID()}`;
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GS Agentic Manager", issuePrefix: "GHE" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: userId,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });
    const externalObjectId = randomUUID();
    await db.insert(externalObjects).values({
      id: externalObjectId,
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "paperclipai/paperclip#pull/123",
      statusCategory: "open",
      statusTone: "info",
      data: { provider: "github", marker: "preserved" },
    });

    const leasedEvent = {
      id: "delivery_merged_123",
      provider: "github" as const,
      event: "pull_request",
      action: "closed",
      installationId: "101",
      repositoryId: "99",
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
        body: "private pull request body",
        comments: [{ body: "private review comment" }],
        accessToken: "ghu_must_not_be_persisted",
        arbitraryNested: { credential: "also-must-not-be-persisted" },
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${++poll}`, events: [leasedEvent] })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 1, duplicate: 0, failed: 0 });
    const [snapshot] = await db.select().from(externalObjects).where(eq(externalObjects.id, externalObjectId));
    expect(snapshot).toMatchObject({
      statusKey: "merged",
      statusLabel: "Merged",
      statusCategory: "succeeded",
      statusTone: "success",
      isTerminal: true,
      remoteVersion: "2026-09-04T11:59:01.000Z",
      data: expect.objectContaining({ marker: "preserved", merged: true, headRef: "feature", baseSha: "b".repeat(40) }),
    });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ webhookHealth: "healthy", lastWebhookAt: currentTime.toISOString() });
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({
      status: "processed",
      attempts: 1,
      provider: "github",
      normalizedPayload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private pull request|private review|ghu_|also-must-not/);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "tool_connection.webhook_processed"));
    expect(activity?.details).toEqual({
      provider: "github",
      event: "pull_request",
      action: "closed",
      deliveryId: leasedEvent.id,
      installationId: "101",
      repositoryId: "99",
    });
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(1);

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 0, duplicate: 1, failed: 0 });
    const [duplicateReceipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(duplicateReceipt?.attempts).toBe(1);
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("applies installation events once without discarding newer verified access (refreshed: %s)", async (refreshed) => {
    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GS Agentic Manager", issuePrefix: "GHI" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });

    const leasedEvent = {
      id: "delivery_repository_change_101",
      provider: "github" as const,
      event: "installation_repositories",
      action: "added",
      installationId: "101",
      repositoryId: null,
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repositorySelection: "selected",
        repositoriesAdded: ["201", "202"],
        repositoriesRemoved: ["203"],
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => {
        if (refreshed) {
          const [latest] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
          await db.update(connectionGrants).set({ providerTenant: {
            ...latest!.providerTenant,
            github: { ...latest!.providerTenant!.github!, lastAccessRefreshAt: "2026-09-04T12:00:02.000Z" },
          } }).where(eq(connectionGrants.id, grantId));
        }
        return ({ leaseId: `lease-${++poll}`, events: [leasedEvent] });
      }),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => {
      throw new Error("fixture live subscriber failed");
    });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, duplicate: 0, failed: 0 });
    unsubscribe();
    let [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ repositoryCount: refreshed ? 3 : 4, webhookHealth: "healthy" });
    if (refreshed) {
      expect(grant?.providerTenant?.github?.repositories).toHaveLength(1);
    } else {
      expect(grant?.providerTenant?.github?.repositories).toBeUndefined();
    }

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 1, failed: 0 });
    [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github?.repositoryCount).toBe(refreshed ? 3 : 4);
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({ status: "processed", attempts: 1 });
  });

  async function seedGitHubBinding() {
    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GS Agentic Manager", issuePrefix: "GHB" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: randomUUID(),
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 1,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          webhookHealth: "healthy",
        },
      },
    });
  }

  function connectorLeasing(leaseEvents: (...args: unknown[]) => Promise<unknown>) {
    const lease = vi.fn(leaseEvents);
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: lease,
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    return { connector, lease };
  }

  const nothingPolled = { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };

  it("backs off failed lease requests instead of retrying on every scheduler tick", async () => {
    await seedGitHubBinding();
    const unavailable = new PaperclipCloudConnectorError(
      "Paperclip Cloud connector is unavailable",
      "CONNECTOR_UNAVAILABLE",
      undefined,
      { reason: "timeout" },
    );
    let brokerUp = false;
    const { connector, lease } = connectorLeasing(async () => {
      if (!brokerUp) throw unavailable;
      return null;
    });
    let currentTime = Date.parse("2026-10-02T16:02:12.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => new Date(currentTime) });

    await expect(service.pollOnce()).rejects.toBe(unavailable);
    expect(lease).toHaveBeenCalledTimes(1);
    // Same shape as the empty-poll backoff: 10s, 20s, 40s, 80s, 160s, then capped at 5 minutes.
    for (const delay of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      const calls = lease.mock.calls.length;
      currentTime += delay - 1;
      await expect(service.pollOnce()).resolves.toEqual(nothingPolled);
      expect(lease).toHaveBeenCalledTimes(calls);
      currentTime += 1;
      await expect(service.pollOnce()).rejects.toBe(unavailable);
      expect(lease).toHaveBeenCalledTimes(calls + 1);
    }

    // A lease that succeeds ends the outage, so the next failure starts again at 10s.
    brokerUp = true;
    currentTime += 300_000;
    await expect(service.pollOnce()).resolves.toEqual(nothingPolled);
    brokerUp = false;
    currentTime += 10_000;
    await expect(service.pollOnce()).rejects.toBe(unavailable);
    const calls = lease.mock.calls.length;
    currentTime += 9_999;
    await expect(service.pollOnce()).resolves.toEqual(nothingPolled);
    expect(lease).toHaveBeenCalledTimes(calls);
    currentTime += 1;
    await expect(service.pollOnce()).rejects.toBe(unavailable);
  });

  it("keeps a long broker outage to a bounded number of lease requests", async () => {
    await seedGitHubBinding();
    const { connector, lease } = connectorLeasing(async () => {
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector is unavailable", "CONNECTOR_UNAVAILABLE");
    });
    let currentTime = Date.parse("2026-10-02T16:02:12.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => new Date(currentTime) });

    // The 2 October outage lasted about 106 minutes with a scheduler tick every
    // 28 seconds: 227 ticks, each of which used to send a signed lease request.
    const ticks = Math.floor((106 * 60_000) / 28_000);
    let failures = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      await service.pollOnce().catch(() => { failures += 1; });
      currentTime += 28_000;
    }
    expect(failures).toBe(lease.mock.calls.length);
    expect(lease.mock.calls.length).toBeLessThanOrEqual(26);
  });

  it("runs one poll at a time and only supersedes a poll that has stalled", async () => {
    await seedGitHubBinding();
    const pending: Array<(value: null) => void> = [];
    const { connector, lease } = connectorLeasing(() => new Promise<null>((resolve) => { pending.push(resolve); }));
    let currentTime = Date.parse("2026-10-02T17:18:00.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => new Date(currentTime) });

    const stalled = service.pollOnce();
    await vi.waitFor(() => expect(lease).toHaveBeenCalledTimes(1));
    // Scheduler ticks keep arriving while the first poll is stuck.
    for (let tick = 0; tick < 10; tick += 1) {
      currentTime += 28_000;
      await expect(service.pollOnce()).resolves.toEqual(nothingPolled);
    }
    expect(lease).toHaveBeenCalledTimes(1);

    // Five minutes after it started, a stuck poll no longer blocks the schedule.
    currentTime = Date.parse("2026-10-02T17:23:00.000Z");
    const replacement = service.pollOnce();
    await vi.waitFor(() => expect(lease).toHaveBeenCalledTimes(2));

    // The stalled poll finishing late must not release the replacement's slot.
    pending[0]!(null);
    await expect(stalled).resolves.toEqual(nothingPolled);
    currentTime += 60_000;
    await expect(service.pollOnce()).resolves.toEqual(nothingPolled);
    expect(lease).toHaveBeenCalledTimes(2);

    pending[1]!(null);
    await expect(replacement).resolves.toEqual(nothingPolled);
    currentTime += 5 * 60_000;
    const next = service.pollOnce();
    await vi.waitFor(() => expect(lease).toHaveBeenCalledTimes(3));
    pending[2]!(null);
    await expect(next).resolves.toEqual(nothingPolled);
  });
});
