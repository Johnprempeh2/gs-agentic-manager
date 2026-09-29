// Starts an embedded Postgres cluster, prints its postmaster pid and SysV
// shared-memory id, then waits to be killed. Used to reproduce GRE-211.
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const [dataDir, port] = process.argv.slice(2);
const instance = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "paperclip",
  password: "paperclip",
  port: Number(port),
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
  onLog: () => {},
  onError: () => {},
});
await instance.initialise();
await instance.start();
// postmaster.pid line 1 is the postmaster pid; line 7 is "<key> <shmid>".
const lines = fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n");
process.stdout.write(`${JSON.stringify({ pid: Number(lines[0]), shmId: lines[6].trim().split(/\s+/)[1] })}\n`);
setInterval(() => {}, 1 << 30);
