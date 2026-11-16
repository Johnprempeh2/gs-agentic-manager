import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultLocalProcessInspector } from "../middleware/local-agent-process-boundary.js";

const readlinks = vi.hoisted(() => ({ inFlight: 0, peak: 0, calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      readlinks.calls += 1;
      readlinks.inFlight += 1;
      readlinks.peak = Math.max(readlinks.peak, readlinks.inFlight);
      try {
        return await actual.readlink(...args);
      } finally {
        readlinks.inFlight -= 1;
      }
    },
  };
});

const idleClient = [
  "const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');",
  "socket.on('connect', () => process.stdout.write('connected'));",
  "setInterval(() => {}, 1000);",
].join("\n");

describe.skipIf(process.platform !== "linux")("finding the process behind a local connection on Linux", () => {
  let server: net.Server;
  let client: ChildProcess;
  let accepted: net.Socket;

  beforeAll(async () => {
    const connection = new Promise<net.Socket>((resolve) => {
      server = net.createServer((socket) => resolve(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    client = spawn(process.execPath, ["-e", idleClient, String(port)], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => client.stdout!.once("data", () => resolve()));
    accepted = await connection;
  });

  afterAll(async () => {
    client.kill();
    accepted.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  // GRE-5506: awaiting one readlink at a time over every /proc/<pid>/fd took ~0.8 s per lookup
  // and added seconds to each operator page load.
  it("reads process fds in parallel, within a bound, and still finds the owner", async () => {
    readlinks.peak = 0;
    readlinks.calls = 0;
    const owners = await defaultLocalProcessInspector("linux")!.findPeerPids([{
      remoteAddress: accepted.remoteAddress!,
      remotePort: accepted.remotePort!,
      localAddress: accepted.localAddress!,
      localPort: accepted.localPort!,
    }]);
    expect(owners).toEqual([client.pid]);
    expect(readlinks.calls).toBeGreaterThan(1);
    expect(readlinks.peak).toBeGreaterThan(1);
    expect(readlinks.peak).toBeLessThanOrEqual(8 * 32);
  });
});
