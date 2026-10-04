import { describe, expect, it } from "vitest";
import {
  classifyDestination,
  descendants,
  ipInCidr,
  parsePpid,
  parseSsOutput,
  readResolvers,
  summarizeEgress,
} from "./memory-egress-check.mjs";

const SS_SAMPLE = [
  'tcp   ESTAB   0 0 172.24.1.5:51234      160.79.104.10:443     users:(("claude",pid=4102,fd=21))',
  'tcp   ESTAB   0 0 127.0.0.1:40110       127.0.0.1:15432       users:(("python",pid=4000,fd=9))',
  'tcp   ESTAB   0 0 [::ffff:172.24.1.5]:5 [2607:6bb0::7]:443    users:(("claude",pid=4103,fd=4))',
  'udp   ESTAB   0 0 172.24.1.5:36000      10.255.255.254:53     users:(("python",pid=4000,fd=12))',
  'tcp   ESTAB   0 0 172.24.1.5:51240      18.244.10.2:443       users:(("python",pid=4000,fd=30))',
  'tcp   ESTAB   0 0 172.24.1.5:51250      100.101.2.3:22        users:(("ssh",pid=999,fd=3))',
  'udp   UNCONN  0 0 0.0.0.0:5353          0.0.0.0:*             users:(("avahi",pid=50,fd=1))',
].join("\n");

describe("ipInCidr", () => {
  it("matches IPv4, IPv6 and IPv4-mapped IPv6", () => {
    expect(ipInCidr("160.79.105.255", "160.79.104.0/23")).toBe(true);
    expect(ipInCidr("160.79.106.0", "160.79.104.0/23")).toBe(false);
    expect(ipInCidr("2607:6bb0:1::1", "2607:6bb0::/32")).toBe(true);
    expect(ipInCidr("2607:6bb1::1", "2607:6bb0::/32")).toBe(false);
    expect(ipInCidr("::ffff:127.0.0.1", "127.0.0.0/8")).toBe(true);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("not-an-ip", "127.0.0.0/8")).toBe(false);
  });
});

describe("parseSsOutput", () => {
  it("reads peers and owning pids and skips wildcard peers", () => {
    const sockets = parseSsOutput(SS_SAMPLE);
    expect(sockets).toHaveLength(6);
    expect(sockets[0]).toMatchObject({ host: "160.79.104.10", port: 443, pids: [{ command: "claude", pid: 4102 }] });
    expect(sockets[2]).toMatchObject({ host: "2607:6bb0::7", port: 443 });
  });
});

describe("process tree", () => {
  it("reads the parent pid even when the command has spaces and parentheses", () => {
    expect(parsePpid("4102 (claude (cli)) S 4000 4102 4000 0 -1")).toBe(4000);
  });

  it("follows children of children", () => {
    const parentOf = new Map([
      [4000, 1],
      [4101, 4000],
      [4102, 4101],
      [999, 1],
    ]);
    expect([...descendants([4000], parentOf)].sort()).toEqual([4000, 4101, 4102]);
  });
});

describe("summarizeEgress", () => {
  const context = { allowedIps: new Set(), resolvers: readResolvers("nameserver 10.255.255.254\n") };

  function recordsFor(rootPid) {
    const parentOf = new Map([
      [4000, 1],
      [4102, 4000],
      [4103, 4000],
      [999, 1],
    ]);
    const tree = descendants([rootPid], parentOf);
    return parseSsOutput(SS_SAMPLE)
      .filter((socket) => socket.pids.some((owner) => tree.has(owner.pid)))
      .map((socket) => ({ at: "2026-10-04T21:00:00Z", host: socket.host, port: socket.port, commands: socket.pids.map((p) => p.command) }));
  }

  it("fails when the engine reaches a non-Anthropic internet host, and ignores processes outside the tree", () => {
    const summary = summarizeEgress(recordsFor(4000), context);
    expect(summary.pass).toBe(false);
    expect(summary.violations.map((v) => `${v.host}:${v.port}`)).toEqual(["18.244.10.2:443"]);
    // The ssh process to the tailnet is not in the engine tree.
    expect(summary.destinations.some((d) => d.host === "100.101.2.3")).toBe(false);
    expect(summary.outsideKinds).toEqual(["anthropic", "internet"]);
  });

  it("passes when Anthropic is the only outside destination", () => {
    const records = recordsFor(4000).filter((record) => record.host !== "18.244.10.2");
    const summary = summarizeEgress(records, context);
    expect(summary.pass).toBe(true);
    expect(summary.outsideKinds).toEqual(["anthropic"]);
  });

  it("allows a resolved Anthropic host address and names tailnet leaks", () => {
    expect(classifyDestination({ host: "104.18.1.1", port: 443 }, { allowedIps: new Set(["104.18.1.1"]), resolvers: [] }))
      .toEqual({ allowed: true, kind: "anthropic" });
    expect(classifyDestination({ host: "100.101.2.3", port: 443 }, context)).toEqual({ allowed: false, kind: "tailnet" });
    expect(classifyDestination({ host: "10.255.255.254", port: 443 }, context)).toEqual({ allowed: false, kind: "lan" });
  });
});
