import path from "node:path";
import {
  DEFAULT_GSAM_INSTANCE_ID,
  expandHomePrefix,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipInstanceId,
} from "../packages/shared/src/home-paths.ts";

// Legacy PAPERCLIP_* names are listed too: the server re-adopts them as GSAM_*.
const INHERITED_PARENT_SERVER_ENV_KEYS = [
  "GSAM_API_URL",
  "GSAM_API_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
] as const;

export interface AppliedDevRunnerOptions {
  forwardedArgs: string[];
  dataDir: string | null;
}

function requireOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function applyDevRunnerOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppliedDevRunnerOptions {
  const forwardedArgs: string[] = [];
  let dataDirRaw: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data-dir" || arg === "-d") {
      dataDirRaw = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      const value = arg.slice("--data-dir=".length).trim();
      if (!value) throw new Error("--data-dir requires a value");
      dataDirRaw = value;
      continue;
    }
    forwardedArgs.push(arg);
  }

  if (!dataDirRaw) {
    return { forwardedArgs, dataDir: null };
  }

  const dataDir = path.resolve(cwd, expandHomePrefix(dataDirRaw));
  const hasExplicitConfig = Boolean(env.GSAM_CONFIG?.trim());
  const hasExplicitContext = Boolean(env.GSAM_CONTEXT?.trim());

  env.GSAM_HOME = dataDir;
  if (!hasExplicitConfig) {
    const instanceId = resolvePaperclipInstanceId(
      env.GSAM_INSTANCE_ID ?? DEFAULT_GSAM_INSTANCE_ID,
    );
    env.GSAM_INSTANCE_ID = instanceId;
    env.GSAM_CONFIG = resolvePaperclipConfigPathForInstance({
      homeDir: dataDir,
      instanceId,
    });
  }
  if (!hasExplicitContext) {
    env.GSAM_CONTEXT = path.resolve(dataDir, "context.json");
  }

  // A sandbox is usually started from an agent shell, which carries the
  // parent server's API URL and agent key. The server prefers an inherited
  // GSAM_API_URL over its own listen port, so without this every agent the
  // sandbox runs would call the parent (live) server instead. (GRE-219)
  for (const key of INHERITED_PARENT_SERVER_ENV_KEYS) {
    delete env[key];
  }

  return { forwardedArgs, dataDir };
}
