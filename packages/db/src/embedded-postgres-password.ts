import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { expandHomePrefix } from "@greatstone/shared/home-paths";

/** Role created by initdb for every embedded cluster. */
export const EMBEDDED_POSTGRES_USER = "paperclip";

/**
 * The fixed password every embedded cluster used before GRE-930. The server
 * tries it once to move its own old cluster onto the random password. Other
 * tools use it only for a cluster whose server has not done that move yet;
 * once moved, the cluster refuses it.
 */
const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

const PASSWORD_FILE_NAME = "embedded-postgres.password";

/**
 * The password lives next to the instance's other secrets:
 * `<instanceRoot>/secrets/embedded-postgres.password` for the default
 * `<instanceRoot>/db` data directory.
 */
export function resolveEmbeddedPostgresPasswordFile(dataDir: string): string {
  return path.resolve(path.dirname(path.resolve(expandHomePrefix(dataDir))), "secrets", PASSWORD_FILE_NAME);
}

function readPasswordFile(file: string): string {
  const password = readFileSync(file, "utf8").trim();
  if (!password) {
    throw new Error(`Embedded PostgreSQL password file is empty: ${file}`);
  }
  return password;
}

/** Reads the stored password, or null when this cluster has none yet. */
export function readEmbeddedPostgresPassword(dataDir: string): string | null {
  const file = resolveEmbeddedPostgresPasswordFile(dataDir);
  if (!existsSync(file)) return null;
  return readPasswordFile(file);
}

/**
 * Returns the cluster's stored password, creating a random one on first use.
 * The file is written whole (temp file + hard link) with mode 600, so a crash
 * never leaves a half-written password and two starters cannot race to two
 * different values.
 */
export function ensureEmbeddedPostgresPasswordFile(dataDir: string): { password: string; created: boolean } {
  const file = resolveEmbeddedPostgresPasswordFile(dataDir);
  if (existsSync(file)) {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return { password: readPasswordFile(file), created: false };
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another starter won the race; use its password.
    return { password: readPasswordFile(file), created: false };
  } finally {
    rmSync(temp, { force: true });
  }
  return { password, created: true };
}

export function embeddedPostgresConnectionString(input: {
  password: string;
  port: number;
  database?: string;
  host?: string;
}): string {
  const host = input.host ?? "127.0.0.1";
  const database = input.database ?? "paperclip";
  return `postgres://${EMBEDDED_POSTGRES_USER}:${encodeURIComponent(input.password)}@${host}:${input.port}/${database}`;
}

/**
 * Password for tools that are not the instance's own server (CLI commands,
 * scripts, worktree seeding). They never change the role: only the server
 * moves its cluster off the old fixed password. Until that server has started
 * once with GRE-930, its cluster still uses the old password.
 */
export function resolveEmbeddedPostgresClientPassword(dataDir: string): string {
  return readEmbeddedPostgresPassword(dataDir) ?? LEGACY_EMBEDDED_POSTGRES_PASSWORD;
}

/**
 * Password for a tool that is about to start the cluster at `dataDir` itself.
 * A brand-new cluster gets a stored random password before initdb; an
 * existing one keeps whatever its server set (see above).
 */
export function resolveEmbeddedPostgresStartPassword(dataDir: string): string {
  const clusterExists = existsSync(path.resolve(expandHomePrefix(dataDir), "PG_VERSION"));
  return clusterExists
    ? resolveEmbeddedPostgresClientPassword(dataDir)
    : ensureEmbeddedPostgresPasswordFile(dataDir).password;
}

export function resolveEmbeddedPostgresConnectionString(input: {
  dataDir: string;
  port: number;
  database?: string;
}): string {
  return embeddedPostgresConnectionString({
    password: resolveEmbeddedPostgresClientPassword(input.dataDir),
    port: input.port,
    database: input.database,
  });
}

function isPasswordRefused(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "28P01";
}

async function canLogIn(port: number, password: string): Promise<boolean> {
  const sql = postgres(embeddedPostgresConnectionString({ password, port, database: "postgres" }), {
    max: 1,
    onnotice: () => {},
    connect_timeout: 10,
  });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    if (isPasswordRefused(err)) return false;
    throw err;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

function sameDirectory(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

export type EmbeddedPostgresPasswordStatus = "current" | "migrated";

/**
 * Makes the running cluster on `port` accept the stored password.
 *
 * Safe to repeat and safe to interrupt: the password file is written before
 * the role changes, so after a crash the next start either logs in with the
 * stored password ("current") or still finds the old fixed password and
 * finishes the change ("migrated"). The role is only changed after checking
 * that the server on `port` really owns `dataDir`.
 */
export async function ensureEmbeddedPostgresRolePassword(input: {
  dataDir: string;
  port: number;
  password: string;
}): Promise<EmbeddedPostgresPasswordStatus> {
  if (await canLogIn(input.port, input.password)) return "current";

  const passwordFile = resolveEmbeddedPostgresPasswordFile(input.dataDir);
  const legacy = postgres(
    embeddedPostgresConnectionString({ password: LEGACY_EMBEDDED_POSTGRES_PASSWORD, port: input.port, database: "postgres" }),
    { max: 1, onnotice: () => {}, connect_timeout: 10 },
  );
  try {
    let rows: { data_directory: string | null }[];
    try {
      rows = await legacy<{ data_directory: string | null }[]>`
        SELECT current_setting('data_directory', true) AS data_directory
      `;
    } catch (err) {
      if (isPasswordRefused(err)) {
        throw new Error(
          `Embedded PostgreSQL on port ${input.port} refused the password stored in ${passwordFile}. ` +
            "The file does not match this cluster; restore the file from backup.",
        );
      }
      throw err;
    }
    const actual = rows[0]?.data_directory;
    if (typeof actual !== "string" || !sameDirectory(actual, input.dataDir)) {
      throw new Error(
        `Refusing to change the PostgreSQL password on port ${input.port}: it does not serve ${input.dataDir}.`,
      );
    }
    // ALTER ROLE takes no bind parameters. The generated password is
    // base64url, and quotes are doubled for any hand-written one.
    const literal = `'${input.password.replace(/'/g, "''")}'`;
    await legacy.unsafe(`ALTER ROLE "${EMBEDDED_POSTGRES_USER}" WITH PASSWORD ${literal}`);
  } finally {
    await legacy.end({ timeout: 5 }).catch(() => {});
  }

  if (!(await canLogIn(input.port, input.password))) {
    throw new Error(`Embedded PostgreSQL on port ${input.port} still refuses the new password after the change.`);
  }
  return "migrated";
}

export type EmbeddedPostgresLegacyRestoreStatus = "no-password-file" | "restored" | "already-legacy";

/**
 * Rollback only: puts the cluster back on the old fixed password so a release
 * from before GRE-930 can log in again, and moves the password file aside
 * (`<file>.rolled-back-<time>`). A later release makes a new random password
 * on its first start. Safe to repeat: after an interrupted run the cluster
 * either still takes the stored password (redo) or already takes the old one
 * (only the file move is left).
 */
export async function restoreLegacyEmbeddedPostgresPassword(input: {
  dataDir: string;
  port: number;
}): Promise<EmbeddedPostgresLegacyRestoreStatus> {
  const file = resolveEmbeddedPostgresPasswordFile(input.dataDir);
  const password = readEmbeddedPostgresPassword(input.dataDir);
  if (!password) return "no-password-file";
  const moveFileAside = () =>
    renameSync(file, `${file}.rolled-back-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  if (await canLogIn(input.port, LEGACY_EMBEDDED_POSTGRES_PASSWORD)) {
    moveFileAside();
    return "already-legacy";
  }
  const sql = postgres(embeddedPostgresConnectionString({ password, port: input.port, database: "postgres" }), {
    max: 1,
    onnotice: () => {},
    connect_timeout: 10,
  });
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    if (typeof actual !== "string" || !sameDirectory(actual, input.dataDir)) {
      throw new Error(
        `Refusing to change the PostgreSQL password on port ${input.port}: it does not serve ${input.dataDir}.`,
      );
    }
    await sql.unsafe(`ALTER ROLE "${EMBEDDED_POSTGRES_USER}" WITH PASSWORD '${LEGACY_EMBEDDED_POSTGRES_PASSWORD}'`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  if (!(await canLogIn(input.port, LEGACY_EMBEDDED_POSTGRES_PASSWORD))) {
    throw new Error(`Embedded PostgreSQL on port ${input.port} still refuses the old password after the change.`);
  }
  moveFileAside();
  return "restored";
}
