import { expect, it, vi } from "vitest";
import { findPortWithoutSocketLock, isPortInUseFailure, startOnFreePort } from "./embedded-postgres-port.js";

const bindLost = new Error("bind lost");

it("detects Postgres's bind failure in the startup logs", () => {
  expect(isPortInUseFailure([
    "LOG:  starting PostgreSQL 17",
    'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use',
  ])).toBe(true);
  expect(isPortInUseFailure(["FATAL:  could not create shared memory segment"])).toBe(false);
});

// GRE-372: two sandboxes probed 54330 at the same moment; the other bound first.
it("moves past a port taken between the probe and the bind", async () => {
  const taken = new Set([54329]);
  const findFreePort = vi.fn(async (from: number) => {
    let port = from;
    while (taken.has(port)) port += 1;
    return port;
  });
  const start = vi.fn(async (port: number) => {
    if (port === 54330) throw bindLost;
  });
  const onRetry = vi.fn();

  const port = await startOnFreePort({
    requestedPort: 54329,
    findFreePort,
    start,
    lostBindRace: (err) => err === bindLost,
    onRetry,
  });

  expect(port).toBe(54331);
  expect(start.mock.calls.map(([p]) => p)).toEqual([54330, 54331]);
  expect(onRetry).toHaveBeenCalledWith(54330, 1);
});

it("does not retry other start failures", async () => {
  const other = new Error("shared memory");
  const start = vi.fn(async (_port: number) => { throw other; });
  await expect(startOnFreePort({
    requestedPort: 54329,
    findFreePort: async (from) => from,
    start,
    lostBindRace: (err) => err === bindLost,
  })).rejects.toBe(other);
  expect(start).toHaveBeenCalledTimes(1);
});

it("gives up after the attempt budget", async () => {
  const start = vi.fn(async (_port: number) => { throw bindLost; });
  await expect(startOnFreePort({
    requestedPort: 54329,
    findFreePort: async (from) => from,
    start,
    lostBindRace: (err) => err === bindLost,
    maxAttempts: 3,
  })).rejects.toBe(bindLost);
  expect(start.mock.calls.map(([p]) => p)).toEqual([54329, 54330, 54331]);
});

// GRE-2381: a sandbox killed without a clean stop left /tmp/.s.PGSQL.54330.lock;
// its PID was reused, so Postgres refused 54330 though TCP showed it free.
it("skips a free TCP port that has a stale socket lock", async () => {
  const locked = new Set([54330]);
  const detectFreePort = vi.fn(async (from: number) => from);

  const port = await findPortWithoutSocketLock({
    from: 54330,
    detectFreePort,
    hasSocketLock: (candidate) => locked.has(candidate),
  });

  expect(port).toBe(54331);
  expect(detectFreePort.mock.calls.map(([p]) => p)).toEqual([54330, 54331]);
});

it("gives up after the lookahead when every port is locked", async () => {
  await expect(findPortWithoutSocketLock({
    from: 54330,
    detectFreePort: async (from) => from,
    hasSocketLock: () => true,
    maxLookahead: 3,
  })).rejects.toThrow(/54330 to 54332/);
});

it("treats a socket lock taken before the start as a lost race", () => {
  expect(isPortInUseFailure([
    'FATAL:  lock file "/tmp/.s.PGSQL.54330.lock" already exists',
    "HINT:  Is another postmaster (PID 961) using socket file \"/tmp/.s.PGSQL.54330\"?",
  ])).toBe(true);
});
