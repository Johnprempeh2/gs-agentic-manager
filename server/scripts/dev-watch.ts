import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);

const child = spawn(
  process.execPath,
  [tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"],
  {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
  },
);

// The dev runner stops the server with SIGTERM to the head of its process tree,
// which reaches this wrapper only. Pass it on to `tsx watch`, which stops the
// server it runs. SIGINT is left alone: a Ctrl-C in a terminal already reaches
// `tsx watch` directly, and a second SIGINT makes it force-kill the server.
const forwardSigterm = () => {
  child.kill("SIGTERM");
};
process.on("SIGTERM", forwardSigterm);

child.on("exit", (code, signal) => {
  process.off("SIGTERM", forwardSigterm);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
