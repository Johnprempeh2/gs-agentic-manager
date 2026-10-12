// The default metrics database: the embedded local instance on port 54329.
// Its password is the random one the server keeps in
// <instance>/secrets/embedded-postgres.password (GRE-930). An instance whose
// server has not started on that version yet still uses the old fixed one.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDatabaseUrl(env = process.env) {
  const home = env.GSAM_HOME?.trim()
    ? resolve(env.GSAM_HOME.trim().replace(/^~(?=$|\/)/, homedir()))
    : join(homedir(), ".gsam");
  const instanceId = env.GSAM_INSTANCE_ID?.trim() || "default";
  const file = join(home, "instances", instanceId, "secrets", "embedded-postgres.password");
  const password = existsSync(file) ? readFileSync(file, "utf8").trim() : "paperclip";
  return `postgres://paperclip:${encodeURIComponent(password)}@127.0.0.1:54329/paperclip`;
}
