import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "./home-paths.js";
import { logger } from "./middleware/logger.js";

const MIN_GENERATED_SECRET_LENGTH = 32;

function resolveGeneratedSecretFilePath() {
  return path.join(path.dirname(resolveDefaultSecretsKeyFilePath()), "agent-jwt.key");
}

function assertOwnedByCurrentUser(stats: Stats, description: string) {
  if (process.platform === "win32") return;

  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`${description} must be owned by the GS Agentic Manager process user`);
  }
}

function enforceKeyFilePermissions(keyPath: string) {
  let stats = lstatSync(keyPath);
  if (!stats.isFile()) {
    throw new Error(`Agent JWT key at ${keyPath} must be a regular file`);
  }
  assertOwnedByCurrentUser(stats, `Agent JWT key at ${keyPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(keyPath, 0o600);
    stats = lstatSync(keyPath);
    if (!stats.isFile()) {
      throw new Error(`Agent JWT key at ${keyPath} must be a regular file`);
    }
    assertOwnedByCurrentUser(stats, `Agent JWT key at ${keyPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Agent JWT key at ${keyPath} must have permissions 0600`);
    }
  }
}

function enforceSecretsDirectoryPermissions(directoryPath: string) {
  let stats = lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Agent JWT secrets directory at ${directoryPath} must be a directory`);
  }
  assertOwnedByCurrentUser(stats, `Agent JWT secrets directory at ${directoryPath}`);
  if (process.platform === "win32") return;

  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(directoryPath, 0o700);
    stats = lstatSync(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Agent JWT secrets directory at ${directoryPath} must be a directory`);
    }
    assertOwnedByCurrentUser(stats, `Agent JWT secrets directory at ${directoryPath}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Agent JWT secrets directory at ${directoryPath} must have permissions 0700`);
    }
  }
}

function readGeneratedSecret(keyPath: string): string {
  enforceKeyFilePermissions(keyPath);
  const existing = readFileSync(keyPath, "utf8").trim();
  if (existing.length < MIN_GENERATED_SECRET_LENGTH) {
    throw new Error(
      `Invalid agent JWT key at ${keyPath} (must be at least ${MIN_GENERATED_SECRET_LENGTH} characters); remove the file to regenerate it or set GSAM_AGENT_JWT_SECRET`,
    );
  }
  return existing;
}

function isAlreadyExists(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function createGeneratedSecret(keyPath: string): string {
  const secretsDirectoryPath = path.dirname(keyPath);
  mkdirSync(secretsDirectoryPath, { recursive: true, mode: 0o700 });
  enforceSecretsDirectoryPermissions(secretsDirectoryPath);
  const generated = randomBytes(32).toString("base64");
  const temporaryPath = `${keyPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    writeFileSync(temporaryPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    enforceKeyFilePermissions(temporaryPath);

    try {
      // Publish only a complete key. A hard link is atomic and never replaces a
      // key another server process created first.
      linkSync(temporaryPath, keyPath);
      enforceKeyFilePermissions(keyPath);
      return generated;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return readGeneratedSecret(keyPath);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/**
 * Cached by key path so the per-request verify path does not stat/read the key
 * file on every call, while a changed GSAM_HOME/GSAM_INSTANCE_ID still resolves
 * the owning instance's key.
 */
let generatedSecretCache: { keyPath: string; secret: string } | null = null;

function loadOrCreateGeneratedSecret(): string | null {
  const keyPath = resolveGeneratedSecretFilePath();
  if (generatedSecretCache?.keyPath === keyPath) return generatedSecretCache.secret;

  let secret: string;
  try {
    try {
      enforceSecretsDirectoryPermissions(path.dirname(keyPath));
      secret = readGeneratedSecret(keyPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      secret = createGeneratedSecret(keyPath);
    }
  } catch (error) {
    // A read-only or otherwise unusable secrets directory must not take the
    // server down: fall back to the previous "agent auth unavailable" behaviour,
    // which callers already handle by warning and running without an injected
    // GSAM_API_KEY.
    logger.error(
      { err: error, keyPath },
      "Could not resolve the instance agent JWT key; agent authentication is disabled. Set GSAM_AGENT_JWT_SECRET to restore it.",
    );
    return null;
  }

  generatedSecretCache = { keyPath, secret };
  return secret;
}

/**
 * Master secret behind every agent-scoped token this instance issues: run JWTs
 * (`agent-auth-jwt.ts`) and runtime-tools tokens (`runtime-tools-token.ts`).
 *
 * An explicit env secret always wins, so multi-replica and worktree/fork
 * deployments keep sharing one master secret. When neither env var is set the
 * secret is generated once and persisted per instance under
 * `<instanceRoot>/secrets/agent-jwt.key`, mirroring the decision-signing key.
 *
 * That fallback is what makes agent identity work out of the box on a local
 * install. `local_trusted` never initializes Better Auth, so `BETTER_AUTH_SECRET`
 * is not required to boot and most local installs set neither it nor
 * `GSAM_AGENT_JWT_SECRET`. Without a fallback that silently disabled run-token
 * minting for the whole instance: `createLocalAgentJwt` returned null, adapters
 * spawned without `GSAM_API_KEY`, `/api/agents/me/*` answered 401, and a run's
 * own comments and status writes landed as the board principal instead of the
 * agent — corrupting thread authorship (GRE-4).
 *
 * Returns null only when no env secret is set and the key file cannot be read or
 * created; callers must treat that as "agent authentication unavailable".
 */
export function resolveAgentJwtSecret(): string | null {
  return (
    process.env.GSAM_AGENT_JWT_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    loadOrCreateGeneratedSecret()
  );
}

/**
 * Startup guard: materializes the per-instance key before the first heartbeat
 * mints a run token, so a run never spawns without `GSAM_API_KEY` merely because
 * the key file did not exist yet. A missing env secret is not an error.
 */
export function ensureAgentJwtSecret() {
  resolveAgentJwtSecret();
}
