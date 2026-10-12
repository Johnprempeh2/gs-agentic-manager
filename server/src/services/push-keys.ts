import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";
import { generateVapidKeys, type VapidKeys } from "./web-push.js";

/**
 * The instance's VAPID key pair for Web Push, kept beside the agent JWT key:
 * `<instanceRoot>/secrets/web-push-vapid.json`, 0600, created once. Changing it
 * would invalidate every phone's subscription, so it is never rotated
 * silently.
 */
export function resolveVapidKeyFilePath(): string {
  return path.join(path.dirname(resolveDefaultSecretsKeyFilePath()), "web-push-vapid.json");
}

function isVapidKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== "object") return false;
  const { publicKey, privateKey } = value as Record<string, unknown>;
  return typeof publicKey === "string" && /^[A-Za-z0-9_-]{86,88}$/.test(publicKey) &&
    typeof privateKey === "string" && /^[A-Za-z0-9_-]{42,44}$/.test(privateKey);
}

function readKeyFile(filePath: string): VapidKeys | null {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`Web Push key at ${filePath} must be a regular file`);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) throw new Error(`Web Push key at ${filePath} must be owned by the server user`);
    if ((stats.mode & 0o077) !== 0) chmodSync(filePath, 0o600);
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isVapidKeys(parsed)) throw new Error(`Web Push key at ${filePath} is not a valid key pair`);
  return parsed;
}

/** Load the key pair, creating it on first use (atomically, so two starts agree). */
export function loadOrCreateVapidKeys(filePath: string = resolveVapidKeyFilePath()): VapidKeys {
  const existing = readKeyFile(filePath);
  if (existing) return existing;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(generateVapidKeys())}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() fails if another process created the file first; theirs wins.
    linkSync(temp, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
  const created = readKeyFile(filePath);
  if (!created) throw new Error(`Web Push key at ${filePath} could not be created`);
  return created;
}
