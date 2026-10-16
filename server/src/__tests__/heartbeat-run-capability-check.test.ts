import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents } from "@greatstone/db";
import {
  probeRunCapabilities,
  type ProbeRunCapabilitiesInput,
  type RunCapabilityProbeReport,
} from "@greatstone/adapter-utils/run-capability-probe";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run capability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DOCKER_NOT_RUNNING =
  "Docker is not running on this machine, so this agent cannot start its tests. Ask whoever runs the machine to start Docker.";

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat required tools check at run start", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;
  let tempDir = "";
  const probe = vi.fn<(input: ProbeRunCapabilitiesInput) => Promise<RunCapabilityProbeReport>>();

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.GSAM_AGENT_JWT_SECRET;
    process.env.GSAM_AGENT_JWT_SECRET = "heartbeat-run-capability-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-capability-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runCapabilityProbe: (input) => probe(input) });
  }, 20_000);

  afterEach(async () => {
    probe.mockReset();
    await heartbeat.drainActiveRunExecutions();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.GSAM_AGENT_JWT_SECRET;
    } else {
      process.env.GSAM_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  async function seedAgent(extraConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    tempDir = await mkdtemp(join(tmpdir(), "gsam-capability-check-"));
    const startedMarker = join(tempDir, "agent-started");
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(startedMarker)}, "1")`],
        ...extraConfig,
      },
      runtimeConfig: {},
      permissions: {},
    });
    return { agentId, startedMarker };
  }

  async function capabilityEvents(runId: string) {
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(asc(heartbeatRunEvents.seq));
    return events.filter((event) => event.eventType === "capability_check");
  }

  it("stops a run early with a plain reason when a required tool is missing", async () => {
    probe.mockImplementation((input) =>
      probeRunCapabilities({
        ...input,
        runCommand: async () => ({ exitCode: 1, failure: null }),
      }),
    );
    const { agentId, startedMarker } = await seedAgent({ requiredCapabilities: ["docker"] });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("configuration_incomplete");
    expect(finished?.error).toContain(DOCKER_NOT_RUNNING);
    expect(finished?.resultJson).toMatchObject({
      configurationIncomplete: {
        reason: "required_capability_missing",
        missingCapabilities: ["docker"],
        reasons: [{ capability: "docker", reason: DOCKER_NOT_RUNNING }],
      },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0].required).toEqual(["docker"]);
    // The agent process never started.
    expect(existsSync(startedMarker)).toBe(false);

    const events = await capabilityEvents(queued!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", stream: "system" });
    expect(events[0]?.message).toContain(DOCKER_NOT_RUNNING);
    expect(events[0]?.payload).toMatchObject({
      status: "missing",
      required: ["docker"],
      missing: ["docker"],
      checks: [{ capability: "docker", ok: false, detail: "docker is installed but the daemon is not reachable" }],
    });
  });

  it("starts the agent and records the check when every required tool is present", async () => {
    probe.mockImplementation((input) =>
      probeRunCapabilities({ ...input, runCommand: async () => ({ exitCode: 0, failure: null }) }),
    );
    const { agentId, startedMarker } = await seedAgent({ requiredCapabilities: ["git", "docker"] });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(existsSync(startedMarker)).toBe(true);
    const events = await capabilityEvents(queued!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "info" });
    expect(events[0]?.payload).toMatchObject({ status: "passed", missing: [] });
  });

  it("changes nothing and runs no check when no tools are declared", async () => {
    const { agentId, startedMarker } = await seedAgent({});

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(existsSync(startedMarker)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(await capabilityEvents(queued!.id)).toHaveLength(0);
  });
});
