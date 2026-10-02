// Prints, as JSON, the environment Playwright would give each webServer of a
// config: { ...process.env, ...webServer.env } (playwright/lib/runner, 1.62).
// Used by sandbox-env.test.mjs; run with tsx.
import path from "node:path";
import { pathToFileURL } from "node:url";

const configPath = path.resolve(process.argv[2]!);
const { default: config } = await import(pathToFileURL(configPath).href);
const servers = [config.webServer ?? []].flat() as Array<{ env?: Record<string, string> }>;
process.stdout.write(JSON.stringify(servers.map((server) => ({ ...process.env, ...server.env }))));
