import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultLocalProcessInspector } from "../middleware/local-agent-process-boundary.js";

const proc = vi.hoisted(() => ({ inFlight: 0, peak: 0, readlinks: 0, fdLists: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: ((target: string, ...rest: unknown[]) => {
      const pid = /^\/proc\/(\d+)\/fd$/.exec(String(target))?.[1];
      if (pid) proc.fdLists.push(pid);
      return (actual.readdir as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof actual.readdir,
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      proc.readlinks += 1;
      proc.inFlight += 1;
      proc.peak = Math.max(proc.peak, proc.inFlight);
      try {
        return await actual.readlink(...args);
      } finally {
        proc.inFlight -= 1;
      }
    },
  };
});

const idleClient = [
  "const net = require('node:net');",
  "let open = 0;",
  "for (let index = 0; index < 2; index += 1) {",
  "  net.connect(Number(process.argv[1]), '127.0.0.1').on('connect', () => { if (++open === 2) process.stdout.write('connected'); });",
  "}",
  "setInterval(() => {}, 1000);",
].join("\n");

function endpointsOf(socket: net.Socket) {
  return {
    remoteAddress: socket.remoteAddress!,
    remotePort: socket.remotePort!,
    localAddress: socket.localAddress!,
    localPort: socket.localPort!,
  };
}

function resetCounts() {
  proc.peak = 0;
  proc.readlinks = 0;
  proc.fdLists = [];
}

describe.skipIf(process.platform !== "linux")("finding the process behind a local connection on Linux", () => {
  let server: net.Server;
  let client: ChildProcess;
  const accepted: net.Socket[] = [];

  beforeAll(async () => {
    const connected = new Promise<void>((resolve) => {
      server = net.createServer((socket) => {
        accepted.push(socket);
        if (accepted.length === 2) resolve();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    client = spawn(process.execPath, ["-e", idleClient, String(port)], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => client.stdout!.once("data", () => resolve()));
    await connected;
  });

  afterAll(async () => {
    client.kill();
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  // GRE-5506: awaiting one readlink at a time over every /proc/<pid>/fd took ~0.8 s per lookup,
  // and a page's sockets arrive in waves, so each load waited for several walks in a row.
  it("reads process fds in parallel, within a bound, and still finds the owner", async () => {
    resetCounts();
    const owners = await defaultLocalProcessInspector("linux")!.findPeerPids([endpointsOf(accepted[0]!)]);
    expect(owners).toEqual([client.pid]);
    expect(proc.readlinks).toBeGreaterThan(1);
    expect(proc.peak).toBeGreaterThan(1);
    expect(proc.peak).toBeLessThanOrEqual(8 * 32);
  });

  it("looks first in the process that owned a recent connection", async () => {
    const inspector = defaultLocalProcessInspector("linux")!;
    await inspector.findPeerPids([endpointsOf(accepted[0]!)]);
    resetCounts();
    const owners = await inspector.findPeerPids([endpointsOf(accepted[1]!)]);
    expect(owners).toEqual([client.pid]);
    expect(proc.fdLists.slice(0, 2)).toEqual([String(process.pid), String(client.pid)]);
  });
});
