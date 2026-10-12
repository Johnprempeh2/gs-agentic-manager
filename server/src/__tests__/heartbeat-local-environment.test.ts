import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function statFields(pid: number): string[] | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** Alive and not a zombie. */
function processAlive(pid: number): boolean {
  const fields = statFields(pid);
  return !!fields && fields[0] !== "Z";
}

// A process a test started that may still run; stopped afterwards by its
// exact PID, and only while it still has the same start time.
let leftover: { pid: number; startTicks: string } | null = null;

/** Remembers `pid` only when it carries this run's marker, so it is ours. */
function rememberIfOurs(pid: number, runId: string) {
  try {
    if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`GSAM_RUN_ID=${runId}\0`)) return;
  } catch {
    return;
  }
  const startTicks = statFields(pid)?.[19];
  if (startTicks) leftover = { pid, startTicks };
}

function stopLeftoverFromTest() {
  if (leftover && statFields(leftover.pid)?.[19] === leftover.startTicks) {
    try {
      process.kill(leftover.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  leftover = null;
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

describeEmbeddedPostgres("heartbeat local environment lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.GSAM_AGENT_JWT_SECRET;
    process.env.GSAM_AGENT_JWT_SECRET = "heartbeat-local-environment-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    stopLeftoverFromTest();
    vi.unstubAllEnvs();
    // A run reaches its terminal status before finalizeRun finishes writing
    // its trailing lifecycle events and side effects (see the comment on
    // drainActiveRunExecutions in heartbeat.ts). Drain those in-flight writes
    // before the TRUNCATE below, or a write that lands after the company row
    // is gone violates heartbeat_run_events' foreign key.
    await heartbeat.drainActiveRunExecutions();
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
    // Same reasoning as the afterEach drain: closing the embedded database
    // while a run's finalize work is still in flight lets a queued write hit
    // a socket that cleanup() already tore down.
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.GSAM_AGENT_JWT_SECRET;
    } else {
      process.env.GSAM_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  it("runs work through the default Local environment lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix,
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
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const localRows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "local"));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.name).toBe("Local");

    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(localRows[0]?.id);
    expect(leases[0]?.status).toBe("released");
    expect(leases[0]?.provider).toBe("local");
    expect(leases[0]?.releasedAt).not.toBeNull();

    const context = finished?.contextSnapshot as Record<string, unknown>;
    expect(context.paperclipEnvironment).toMatchObject({
      id: localRows[0]?.id,
      name: "Local",
      driver: "local",
      leaseId: leases[0]?.id,
    });
  });

  it("injects run-scoped GS Agentic Manager env into process agents", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-process-env-"));
    const envPath = join(tempDir, "env.json");

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix,
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
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({`,
            "agentId: process.env.GSAM_AGENT_ID ?? null,",
            "companyId: process.env.GSAM_COMPANY_ID ?? null,",
            "apiUrl: process.env.GSAM_API_URL ?? null,",
            "runId: process.env.GSAM_RUN_ID ?? null,",
            "apiKeyPresent: Boolean(process.env.GSAM_API_KEY),",
            "}));",
          ].join(" "),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const captured = JSON.parse(await readFile(envPath, "utf8")) as Record<string, unknown>;
    expect(captured).toMatchObject({
      agentId,
      companyId,
      runId: queued!.id,
      apiKeyPresent: true,
    });
    expect(captured.apiUrl).toEqual(expect.stringMatching(/^https?:\/\//));
  });

  it.skipIf(process.platform !== "linux")(
    "stops a process the agent left running in the background when the run ends",
    async () => {
      vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const tempDir = await mkdtemp(join(tmpdir(), "gsam-leftover-run-"));
      const pidPath = join(tempDir, "leftover.pid");

      await db.insert(companies).values({
        id: companyId,
        name: "GS Agentic Manager",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      // The agent starts a server in a new session and exits, as an agent's
      // shell tool does with `setsid ... &`. The server inherits the run env.
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "ProcessAgent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {
          command: "sh",
          args: [
            "-c",
            `setsid sh -c 'echo $$ > "$1"; exec sleep 600' sh "${pidPath}" </dev/null >/dev/null 2>&1 & ` +
              `while [ ! -s "${pidPath}" ]; do sleep 0.05; done; sleep 0.2`,
          ],
          cwd: tempDir,
        },
        runtimeConfig: {},
        permissions: {},
      });

      try {
        const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
        expect(queued).not.toBeNull();
        const finished = await waitForRunToFinish(heartbeat, queued!.id);
        expect(finished?.status).toBe("succeeded");
        await heartbeat.drainActiveRunExecutions();

        const leftoverPid = Number((await readFile(pidPath, "utf8")).trim());
        rememberIfOurs(leftoverPid, queued!.id);
        for (let i = 0; i < 100 && processAlive(leftoverPid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(processAlive(leftoverPid)).toBe(false);

        const events = await db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, queued!.id));
        const cleanup = events.find(
          (event) => (event.payload as Record<string, unknown> | null)?.kind === "run_leftover_processes",
        );
        expect(cleanup?.eventType).toBe("lifecycle");
        expect(cleanup?.payload).toMatchObject({
          terminated: 1,
          killed: 0,
          failed: 0,
          processes: [{ pid: leftoverPid, command: "sleep 600", outcome: "terminated" }],
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
