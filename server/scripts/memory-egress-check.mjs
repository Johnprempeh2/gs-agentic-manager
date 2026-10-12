#!/usr/bin/env node
/**
 * Memory engine egress check (GRE-673).
 *
 * Proves that during a synthetic memory run the engine (Hindsight and the
 * `claude` CLI processes it starts for extraction) talks to nobody outside
 * this host except Anthropic.
 *
 *   sample: poll `ss -tunpH` for sockets owned by the engine process tree and
 *           append every remote endpoint seen to a JSONL log.
 *   check:  read the log, classify each destination, print a summary, and
 *           exit 1 if any destination is not loopback, the local DNS resolver
 *           or Anthropic.
 *
 * Usage:
 *   node server/scripts/memory-egress-check.mjs sample --root-pid <pid> [--root-pid <pid>] \
 *     --out <log.jsonl> [--interval-ms 200] [--duration-s 600]
 *   node server/scripts/memory-egress-check.mjs sample --unit gs-memory-hindsight --out <log.jsonl>
 *   node server/scripts/memory-egress-check.mjs check --log <log.jsonl> [--json]
 *
 * `ss -p` shows socket owners only for the caller's own processes (or all, as
 * root). The shared engine runs as user `gsmemory`, so sample it as root or as
 * that user; the sampler refuses to run when it could not see the engine's
 * sockets, and `check` fails an empty log, so a blind run never passes.
 *
 * Limits: polling can miss a connection that opens and closes between two
 * samples. Extraction calls hold a TLS connection for seconds, so they are
 * seen; a very short connection may not be. Read it as evidence, not proof.
 */

import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Anthropic's published API address ranges. */
export const ANTHROPIC_CIDRS = ["160.79.104.0/23", "2607:6bb0::/32"];

/** Hosts the Claude CLI may use on a Max plan login (API, OAuth refresh). Resolved at check time. */
export const ANTHROPIC_HOSTS = [
  "api.anthropic.com",
  "console.anthropic.com",
  "claude.ai",
  "statsig.anthropic.com",
];

const LOOPBACK_CIDRS = ["127.0.0.0/8", "::1/128"];

/** Ranges named in the report so a reviewer can see what kind of leak it is. */
const NAMED_RANGES = [
  { name: "tailnet", cidr: "100.64.0.0/10" },
  { name: "lan", cidr: "10.0.0.0/8" },
  { name: "lan", cidr: "172.16.0.0/12" },
  { name: "lan", cidr: "192.168.0.0/16" },
  { name: "link-local", cidr: "169.254.0.0/16" },
  { name: "link-local", cidr: "fe80::/10" },
  { name: "lan", cidr: "fc00::/7" },
];

function parseIp(address) {
  if (isIPv4(address)) {
    const value = address.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
    return { version: 4, value };
  }
  if (!isIPv6(address)) return null;
  let text = address;
  const tail = [];
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Tail) {
    const v4 = parseIp(v4Tail[1]).value;
    tail.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    text = text.slice(0, -v4Tail[1].length);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const [head, rest] = text.split("::");
  const headGroups = head ? head.split(":").map((part) => parseInt(part, 16)) : [];
  const restGroups = rest === undefined ? null : rest ? rest.split(":").map((part) => parseInt(part, 16)) : [];
  const groups = restGroups === null
    ? [...headGroups, ...tail]
    : [
        ...headGroups,
        ...Array(8 - headGroups.length - restGroups.length - tail.length).fill(0),
        ...restGroups,
        ...tail,
      ];
  const value = groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4.
  if (value >> 32n === 0xffffn) return { version: 4, value: value & 0xffffffffn };
  return { version: 6, value };
}

export function ipInCidr(address, cidr) {
  const [base, bitsText] = cidr.split("/");
  const ip = parseIp(address);
  const net = parseIp(base);
  if (!ip || !net || ip.version !== net.version) return false;
  const width = ip.version === 4 ? 32n : 128n;
  const bits = BigInt(bitsText ?? width);
  const shift = width - bits;
  return ip.value >> shift === net.value >> shift;
}

/** Splits an `ss` address such as `1.2.3.4:443`, `[2607:6bb0::1]:443` or `[::ffff:1.2.3.4]:443`. */
export function splitHostPort(text) {
  const bracket = /^\[([^\]]+)\]:(\d+|\*)$/.exec(text);
  const raw = bracket ? { host: bracket[1], port: bracket[2] } : (() => {
    const index = text.lastIndexOf(":");
    return index < 0 ? null : { host: text.slice(0, index), port: text.slice(index + 1) };
  })();
  if (!raw) return null;
  const host = raw.host.replace(/%.*$/, "");
  if (host === "*" || raw.port === "*") return null;
  return { host, port: Number(raw.port) };
}

/** Parses `ss -tunpH` output into sockets with their owning pids. */
export function parseSsOutput(text) {
  const sockets = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const columns = trimmed.split(/\s+/);
    // With -t and -u together ss prints the netid first: tcp/udp, state, recv-q, send-q, local, peer, process.
    if (columns.length < 6) continue;
    const [netid, state, , , local, peer] = columns;
    const process = columns.slice(6).join(" ");
    const remote = splitHostPort(peer);
    if (!remote) continue;
    const pids = [...process.matchAll(/\("([^"]*)",pid=(\d+)/g)].map((match) => ({
      command: match[1],
      pid: Number(match[2]),
    }));
    sockets.push({ netid, state, local, host: remote.host, port: remote.port, pids });
  }
  return sockets;
}

/** Reads the real uid from /proc/<pid>/status text. */
export function parseUid(statusText) {
  const match = /^Uid:\s+(\d+)/m.exec(statusText);
  return match ? Number(match[1]) : null;
}

/** Parses /proc/<pid>/stat text into its parent pid. The command field may contain spaces and ')'. */
export function parsePpid(statText) {
  const close = statText.lastIndexOf(")");
  if (close < 0) return null;
  const fields = statText.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

export function descendants(rootPids, parentOf) {
  const children = new Map();
  for (const [pid, ppid] of parentOf) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const seen = new Set(rootPids);
  const queue = [...rootPids];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

function readProcessTable() {
  const parentOf = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const ppid = parsePpid(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (ppid !== null) parentOf.set(Number(name), ppid);
    } catch {
      // The process exited between readdir and read.
    }
  }
  return parentOf;
}

export function readResolvers(text) {
  return text
    .split("\n")
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
    .filter(Boolean);
}

/**
 * Classifies one destination. `allowedIps` holds the addresses the Anthropic
 * hosts resolve to now. A destination is allowed when it is loopback, DNS
 * (port 53) to a configured resolver, or Anthropic.
 */
export function classifyDestination({ host, port }, { allowedIps, resolvers }) {
  if (LOOPBACK_CIDRS.some((cidr) => ipInCidr(host, cidr))) return { allowed: true, kind: "loopback" };
  if (port === 53 && resolvers.includes(host)) return { allowed: true, kind: "dns-resolver" };
  if (ANTHROPIC_CIDRS.some((cidr) => ipInCidr(host, cidr)) || allowedIps.has(host)) {
    return { allowed: true, kind: "anthropic" };
  }
  const named = NAMED_RANGES.find((range) => ipInCidr(host, range.cidr));
  return { allowed: false, kind: named ? named.name : "internet" };
}

export function summarizeEgress(records, context) {
  const destinations = new Map();
  for (const record of records) {
    const key = `${record.host}:${record.port}`;
    const existing = destinations.get(key);
    if (existing) {
      existing.samples += 1;
      existing.lastSeen = record.at;
      for (const command of record.commands ?? []) existing.commands.add(command);
      continue;
    }
    destinations.set(key, {
      host: record.host,
      port: record.port,
      ...classifyDestination(record, context),
      samples: 1,
      firstSeen: record.at,
      lastSeen: record.at,
      commands: new Set(record.commands ?? []),
    });
  }
  const list = [...destinations.values()].map((item) => ({ ...item, commands: [...item.commands].sort() }));
  const violations = list.filter((item) => !item.allowed);
  const outside = list.filter((item) => item.kind !== "loopback" && item.kind !== "dns-resolver");
  return {
    samples: records.length,
    destinations: list.sort((a, b) => a.kind.localeCompare(b.kind) || a.host.localeCompare(b.host)),
    outsideKinds: [...new Set(outside.map((item) => item.kind))].sort(),
    violations,
    // An empty log means the sampler saw nothing (wrong pid, or no permission): not evidence of a clean run.
    empty: records.length === 0,
    pass: records.length > 0 && violations.length === 0,
  };
}

function parseArgs(argv) {
  const args = { _: [], rootPids: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root-pid") args.rootPids.push(Number(argv[(index += 1)]));
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[(index += 1)];
    else args._.push(arg);
  }
  return args;
}

async function resolveUnitPid(unit) {
  const { stdout } = await execFileAsync("systemctl", ["show", "-p", "MainPID", "--value", unit]);
  const pid = Number(stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`unit ${unit} is not running`);
  return pid;
}

function assertCanSeeSockets(rootPids) {
  const myUid = process.getuid();
  if (myUid === 0) return;
  for (const pid of rootPids) {
    const ownerUid = parseUid(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (ownerUid !== myUid) {
      throw new Error(`pid ${pid} runs as uid ${ownerUid}; ss cannot see its sockets from uid ${myUid}. Run as root or as that user.`);
    }
  }
}

async function sample(args) {
  if (args.unit) args.rootPids.push(await resolveUnitPid(args.unit));
  if (!args.rootPids.length || !args.out) throw new Error("sample needs --root-pid or --unit, and --out");
  assertCanSeeSockets(args.rootPids);
  const interval = Number(args["interval-ms"] ?? 200);
  const until = args["duration-s"] ? Date.now() + Number(args["duration-s"]) * 1000 : Infinity;
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  let polls = 0;
  while (!stop && Date.now() < until) {
    const tree = descendants(args.rootPids, readProcessTable());
    const { stdout } = await execFileAsync("ss", ["-tunpH"], { maxBuffer: 16 * 1024 * 1024 });
    const at = new Date().toISOString();
    for (const socket of parseSsOutput(stdout)) {
      const owned = socket.pids.filter((owner) => tree.has(owner.pid));
      if (!owned.length) continue;
      appendFileSync(
        args.out,
        `${JSON.stringify({ at, netid: socket.netid, state: socket.state, host: socket.host, port: socket.port, commands: [...new Set(owned.map((o) => o.command))] })}\n`,
      );
    }
    polls += 1;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  process.stderr.write(`egress sample: ${polls} polls written to ${args.out}\n`);
}

async function check(args) {
  if (!args.log) throw new Error("check needs --log");
  const records = readFileSync(args.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const allowedIps = new Set();
  for (const host of ANTHROPIC_HOSTS) {
    try {
      for (const entry of await lookup(host, { all: true })) allowedIps.add(entry.address);
    } catch {
      // Offline at check time: the published CIDRs still apply.
    }
  }
  let resolvers = [];
  try {
    resolvers = readResolvers(readFileSync("/etc/resolv.conf", "utf8"));
  } catch {
    resolvers = [];
  }
  const summary = summarizeEgress(records, { allowedIps, resolvers });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`samples: ${summary.samples}\n`);
    for (const item of summary.destinations) {
      process.stdout.write(
        `${item.allowed ? "ok  " : "FAIL"} ${item.kind.padEnd(12)} ${item.host}:${item.port}  (${item.samples} samples; ${item.commands.join(",")})\n`,
      );
    }
    process.stdout.write(
      `${summary.empty ? "no samples: the engine was not seen (check pid and permissions)\n" : ""}outside destinations: ${summary.outsideKinds.join(", ") || "none"}\nresult: ${summary.pass ? "PASS" : "FAIL"}\n`,
    );
  }
  process.exitCode = summary.pass ? 0 : 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const run = command === "sample" ? sample : command === "check" ? check : null;
  if (!run) {
    process.stderr.write("usage: memory-egress-check.mjs sample|check (see file header)\n");
    process.exit(2);
  }
  run(args).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(2);
  });
}
