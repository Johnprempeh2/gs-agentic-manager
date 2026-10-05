import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  embeddedPostgresConnectionString,
  ensureEmbeddedPostgresPasswordFile,
  ensureEmbeddedPostgresRolePassword,
  readEmbeddedPostgresPassword,
  resolveEmbeddedPostgresClientPassword,
  resolveEmbeddedPostgresPasswordFile,
  resolveEmbeddedPostgresStartPassword,
  restoreLegacyEmbeddedPostgresPassword,
} from "./embedded-postgres-password.js";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const tempRoots: string[] = [];
function makeInstanceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gre-930-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("embedded PostgreSQL password file (GRE-930)", () => {
  it("creates a random 32-byte password in a mode 600 file under <instance>/secrets", () => {
    const dataDir = path.join(makeInstanceRoot(), "db");
    const file = resolveEmbeddedPostgresPasswordFile(dataDir);
    expect(file).toBe(path.join(path.dirname(dataDir), "secrets", "embedded-postgres.password"));

    const first = ensureEmbeddedPostgresPasswordFile(dataDir);
    expect(first.created).toBe(true);
    expect(Buffer.from(first.password, "base64url")).toHaveLength(32);
    expect(first.password).not.toBe("paperclip");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);

    const second = ensureEmbeddedPostgresPasswordFile(dataDir);
    expect(second).toEqual({ password: first.password, created: false });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["embedded-postgres.password"]);
  });

  it("gives each instance its own password", () => {
    const a = ensureEmbeddedPostgresPasswordFile(path.join(makeInstanceRoot(), "db")).password;
    const b = ensureEmbeddedPostgresPasswordFile(path.join(makeInstanceRoot(), "db")).password;
    expect(a).not.toBe(b);
  });

  it("tightens a password file that other users can read", () => {
    const dataDir = path.join(makeInstanceRoot(), "db");
    const { password } = ensureEmbeddedPostgresPasswordFile(dataDir);
    const file = resolveEmbeddedPostgresPasswordFile(dataDir);
    fs.chmodSync(file, 0o644);
    expect(ensureEmbeddedPostgresPasswordFile(dataDir).password).toBe(password);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lets tools other than the server start a new cluster with a stored password, but never invent one for an old cluster", () => {
    const fresh = path.join(makeInstanceRoot(), "db");
    const startPassword = resolveEmbeddedPostgresStartPassword(fresh);
    expect(readEmbeddedPostgresPassword(fresh)).toBe(startPassword);

    const old = path.join(makeInstanceRoot(), "db");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "PG_VERSION"), "18\n");
    expect(resolveEmbeddedPostgresStartPassword(old)).toBe("paperclip");
    expect(readEmbeddedPostgresPassword(old)).toBeNull();
    expect(resolveEmbeddedPostgresClientPassword(old)).toBe("paperclip");
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

type Cluster = { dataDir: string; port: number; stop: () => Promise<void> };

/** Starts a cluster the way a pre-GRE-930 install did: password "paperclip". */
async function startLegacyCluster(dataDir: string): Promise<Cluster> {
  await prepareEmbeddedPostgresNativeRuntime();
  const { default: EmbeddedPostgres } = await loadWithoutEmbeddedPostgresExitHooks(() => import("embedded-postgres"));
  const port = await freePort();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  return { dataDir, port, stop: () => instance.stop() };
}

async function login(port: number, password: string): Promise<"ok" | "refused"> {
  const sql = postgres(embeddedPostgresConnectionString({ password, port, database: "postgres" }), {
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
    return "ok";
  } catch (err) {
    if ((err as { code?: string }).code === "28P01") return "refused";
    throw err;
  } finally {
    await sql.end();
  }
}

describeEmbeddedPostgres("moving an existing cluster off the fixed password (GRE-930)", () => {
  const clusters: Cluster[] = [];
  afterEach(async () => {
    for (const cluster of clusters.splice(0)) await cluster.stop().catch(() => {});
  });

  async function legacyClusterWithData(): Promise<Cluster> {
    const cluster = await startLegacyCluster(path.join(makeInstanceRoot(), "db"));
    clusters.push(cluster);
    const sql = postgres(embeddedPostgresConnectionString({ password: "paperclip", port: cluster.port, database: "postgres" }), {
      max: 1,
      onnotice: () => {},
    });
    await sql`CREATE TABLE kept (note text)`;
    await sql`INSERT INTO kept VALUES ('still here')`;
    await sql.end();
    return cluster;
  }

  it("migrates, keeps the data, refuses the old password, and does nothing on a second start", async () => {
    const cluster = await legacyClusterWithData();
    const { password } = ensureEmbeddedPostgresPasswordFile(cluster.dataDir);

    await expect(ensureEmbeddedPostgresRolePassword({ ...cluster, password })).resolves.toBe("migrated");
    expect(await login(cluster.port, "paperclip")).toBe("refused");
    expect(await login(cluster.port, password)).toBe("ok");

    const sql = postgres(embeddedPostgresConnectionString({ password, port: cluster.port, database: "postgres" }), {
      max: 1,
      onnotice: () => {},
    });
    expect(await sql`SELECT note FROM kept`).toEqual([{ note: "still here" }]);
    await sql.end();

    // Second start: same file, no change.
    expect(ensureEmbeddedPostgresPasswordFile(cluster.dataDir)).toEqual({ password, created: false });
    await expect(ensureEmbeddedPostgresRolePassword({ ...cluster, password })).resolves.toBe("current");
    expect(await login(cluster.port, password)).toBe("ok");
  }, 120_000);

  it("finishes the move after a stop between writing the file and changing the role", async () => {
    const cluster = await legacyClusterWithData();
    // A previous start wrote the file, then stopped before the role change.
    const { password } = ensureEmbeddedPostgresPasswordFile(cluster.dataDir);
    expect(await login(cluster.port, "paperclip")).toBe("ok");

    await expect(ensureEmbeddedPostgresRolePassword({ ...cluster, password })).resolves.toBe("migrated");
    await expect(ensureEmbeddedPostgresRolePassword({ ...cluster, password })).resolves.toBe("current");
  }, 120_000);

  it("never changes the password of a cluster that serves another data directory", async () => {
    const cluster = await legacyClusterWithData();
    const otherDataDir = path.join(makeInstanceRoot(), "db");
    const { password } = ensureEmbeddedPostgresPasswordFile(otherDataDir);

    await expect(
      ensureEmbeddedPostgresRolePassword({ dataDir: otherDataDir, port: cluster.port, password }),
    ).rejects.toThrow(/does not serve/);
    expect(await login(cluster.port, "paperclip")).toBe("ok");
  }, 120_000);

  it("fails loudly, without printing the password, when the file does not match the cluster", async () => {
    const cluster = await legacyClusterWithData();
    const { password } = ensureEmbeddedPostgresPasswordFile(cluster.dataDir);
    await ensureEmbeddedPostgresRolePassword({ ...cluster, password });

    const wrong = "not-the-stored-password";
    const error = await ensureEmbeddedPostgresRolePassword({ ...cluster, password: wrong }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/refused the password stored in/);
    expect((error as Error).message).not.toContain(wrong);
    expect((error as Error).message).not.toContain(password);
  }, 120_000);

  it("rollback puts the old password back once, and a later release migrates again", async () => {
    const cluster = await legacyClusterWithData();
    const { password } = ensureEmbeddedPostgresPasswordFile(cluster.dataDir);
    await ensureEmbeddedPostgresRolePassword({ ...cluster, password });

    await expect(restoreLegacyEmbeddedPostgresPassword(cluster)).resolves.toBe("restored");
    expect(await login(cluster.port, "paperclip")).toBe("ok");
    expect(readEmbeddedPostgresPassword(cluster.dataDir)).toBeNull();
    const secrets = fs.readdirSync(path.dirname(resolveEmbeddedPostgresPasswordFile(cluster.dataDir)));
    expect(secrets.some((name) => name.startsWith("embedded-postgres.password.rolled-back-"))).toBe(true);
    await expect(restoreLegacyEmbeddedPostgresPassword(cluster)).resolves.toBe("no-password-file");

    const next = ensureEmbeddedPostgresPasswordFile(cluster.dataDir);
    expect(next.created).toBe(true);
    expect(next.password).not.toBe(password);
    await expect(ensureEmbeddedPostgresRolePassword({ ...cluster, password: next.password })).resolves.toBe("migrated");
    expect(await login(cluster.port, "paperclip")).toBe("refused");
  }, 120_000);
});
