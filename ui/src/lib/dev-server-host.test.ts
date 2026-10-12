import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEV_SERVER_HOST,
  defaultListenHost,
  isLoopbackHost,
  resolveDevServerHost,
} from "./dev-server-host.mjs";

describe("resolveDevServerHost", () => {
  it("defaults to loopback", () => {
    expect(DEFAULT_DEV_SERVER_HOST).toBe("127.0.0.1");
    expect(resolveDevServerHost(undefined)).toBe("127.0.0.1");
    expect(resolveDevServerHost("")).toBe("127.0.0.1");
    expect(resolveDevServerHost("   ")).toBe("127.0.0.1");
  });

  it("uses GSAM_DEV_HOST when it is set", () => {
    expect(resolveDevServerHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveDevServerHost(" 100.64.0.1 ")).toBe("100.64.0.1");
  });
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "100.64.0.1", "192.168.1.10", "dev-box.tail1234.ts.net", "127.0.0.1.example.com"])(
    "%s is not loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe("defaultListenHost", () => {
  function fakeServer() {
    const calls: unknown[][] = [];
    const server = {
      listen(...args: unknown[]) {
        calls.push(args);
        return server;
      },
    };
    return { server, calls };
  }

  it("fills in the host for Storybook's listen({ port, host: undefined })", () => {
    const { server, calls } = fakeServer();
    const onDefault = vi.fn();
    const cb = () => {};
    defaultListenHost(server, "127.0.0.1", onDefault).listen({ port: 6006, host: undefined }, cb);
    expect(calls).toEqual([[{ port: 6006, host: "127.0.0.1" }, cb]]);
    expect(onDefault).toHaveBeenCalledWith("127.0.0.1");
  });

  it("keeps a host given with --host or SBCONFIG_HOSTNAME", () => {
    const { server, calls } = fakeServer();
    const onDefault = vi.fn();
    const wrapped = defaultListenHost(server, "127.0.0.1", onDefault);
    wrapped.listen({ port: 6006, host: "0.0.0.0" });
    wrapped.listen(6006, "::1");
    expect(calls).toEqual([[{ port: 6006, host: "0.0.0.0" }], [6006, "::1"]]);
    expect(onDefault).not.toHaveBeenCalled();
  });

  it("fills in the host for listen(port), listen(port, cb) and listen(port, undefined, cb)", () => {
    const { server, calls } = fakeServer();
    const cb = () => {};
    const wrapped = defaultListenHost(server, "127.0.0.1");
    wrapped.listen(6006);
    wrapped.listen(6006, cb);
    wrapped.listen("6006", undefined, cb);
    expect(calls).toEqual([
      [6006, "127.0.0.1"],
      [6006, "127.0.0.1", cb],
      ["6006", "127.0.0.1", cb],
    ]);
  });

  it("leaves socket paths alone", () => {
    const { server, calls } = fakeServer();
    const wrapped = defaultListenHost(server, "127.0.0.1");
    wrapped.listen("/tmp/storybook.sock");
    wrapped.listen({ path: "/tmp/storybook.sock" });
    expect(calls).toEqual([["/tmp/storybook.sock"], [{ path: "/tmp/storybook.sock" }]]);
  });

  it("makes a real server listen on loopback only", async () => {
    const server = defaultListenHost(createServer(), "127.0.0.1");
    await new Promise<void>((resolve) => server.listen({ port: 0, host: undefined }, resolve));
    try {
      expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
