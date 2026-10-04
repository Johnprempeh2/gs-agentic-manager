import { describe, expect, it } from "vitest";
import {
  classifyEngineError,
  createInMemoryMemoryIngestStore,
  drainMemoryIngestOutbox,
  getDailyPlanUsage,
  nextAttemptAt,
  parsePlanResetAt,
  type MemoryIngestEngine,
  type MemoryIngestEntry,
} from "./ingest-outbox.js";

const COMPANY = "kestrel-works";
const PLAN_LIMIT_DETAIL =
  "Claude Code returned an error: You've hit your weekly limit · resets Oct 6, 9am (UTC)";

function httpError(status: number, detail: string) {
  return Object.assign(new Error(`Hindsight ${status}`), { status, detail });
}

function connectionRefused() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18888"), { code: "ECONNREFUSED" }),
  });
}

function clock(start: string) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(value: Date) {
      current = new Date(value);
    },
  };
}

function scriptedEngine(script: Array<(entry: MemoryIngestEntry) => unknown>) {
  const calls: string[] = [];
  const engine: MemoryIngestEngine = {
    async apply(entry) {
      calls.push(entry.recordId);
      const step = script.shift();
      if (!step) return { usage: null };
      const outcome = step(entry);
      return (outcome ?? { usage: null }) as { usage: null };
    },
  };
  return { engine, calls };
}

async function seed(store: ReturnType<typeof createInMemoryMemoryIngestStore>, now: Date, count: number) {
  for (let index = 1; index <= count; index += 1) {
    await store.enqueue({
      companyId: COMPANY,
      recordId: `rec-${index}`,
      op: "retain",
      payload: { document_id: `rec-${index}`, content: `Kestrel Works fact ${index}` },
      now,
    });
  }
}

describe("classifyEngineError", () => {
  const now = new Date("2026-10-04T20:00:00Z");

  it("treats the Claude plan quota message (a Hindsight 500) as a plan limit with its reset time", () => {
    const result = classifyEngineError(httpError(500, PLAN_LIMIT_DETAIL), now);
    expect(result.kind).toBe("plan_limit");
    expect(result.retryAt?.toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });

  it("treats 429 and rate-limit text as a plan limit", () => {
    expect(classifyEngineError(httpError(429, "slow down"), now).kind).toBe("plan_limit");
    expect(classifyEngineError(new Error("rate_limit_error"), now).kind).toBe("plan_limit");
  });

  it("treats connection failures, gateway errors, timeouts and key errors as engine unavailable", () => {
    expect(classifyEngineError(connectionRefused(), now).kind).toBe("engine_unavailable");
    expect(classifyEngineError(httpError(503, "starting"), now).kind).toBe("engine_unavailable");
    expect(classifyEngineError(Object.assign(new Error("t"), { name: "TimeoutError" }), now).kind).toBe(
      "engine_unavailable",
    );
    expect(classifyEngineError(httpError(401, "bad key"), now).kind).toBe("engine_unavailable");
  });

  it("reads status and detail through the gateway adapter's wrapper error", () => {
    const wrap = (cause: unknown) =>
      Object.assign(new Error("Memory engine call failed", { cause }), { name: "MemoryEngineUnavailableError" });
    expect(classifyEngineError(wrap(httpError(500, PLAN_LIMIT_DETAIL)), now).kind).toBe("plan_limit");
    expect(classifyEngineError(wrap(httpError(422, "violations")), now).kind).toBe("rejected");
    expect(classifyEngineError(wrap(undefined), now).kind).toBe("engine_unavailable");
  });

  it("treats request errors as rejected and anything else as transient", () => {
    expect(classifyEngineError(httpError(422, "violations"), now).kind).toBe("rejected");
    expect(classifyEngineError(httpError(500, "KeyError: 'x'"), now).kind).toBe("transient");
  });
});

describe("parsePlanResetAt", () => {
  const now = new Date("2026-12-30T22:00:00Z");

  it("rolls a date reset into next year and a time-only reset into tomorrow", () => {
    expect(parsePlanResetAt("resets Jan 2, 12pm (UTC)", now)?.toISOString()).toBe("2027-01-02T12:00:00.000Z");
    expect(parsePlanResetAt("resets 3:30am (UTC)", now)?.toISOString()).toBe("2026-12-31T03:30:00.000Z");
  });

  it("returns null for a time with no UTC marker", () => {
    expect(parsePlanResetAt("resets 3am (Europe/London)", now)).toBeNull();
  });
});

describe("nextAttemptAt", () => {
  const now = new Date("2026-10-04T20:00:00Z");
  const noJitter = () => 0;

  it("doubles from 30s and caps at one hour", () => {
    const transient = { kind: "transient" as const, retryAt: null, message: "" };
    const delay = (attempts: number) =>
      nextAttemptAt({ now, attempts, classified: transient, random: noJitter }).getTime() - now.getTime();
    expect(delay(1)).toBe(30_000);
    expect(delay(2)).toBe(60_000);
    expect(delay(30)).toBe(60 * 60_000);
  });

  it("waits for the plan reset time plus slack, or 15 minutes when no reset time is given", () => {
    const retryAt = new Date("2026-10-05T01:00:00Z");
    expect(
      nextAttemptAt({ now, attempts: 1, classified: { kind: "plan_limit", retryAt, message: "" }, random: noJitter }),
    ).toEqual(new Date("2026-10-05T01:01:00Z"));
    expect(
      nextAttemptAt({ now, attempts: 1, classified: { kind: "plan_limit", retryAt: null, message: "" }, random: noJitter })
        .getTime() - now.getTime(),
    ).toBe(15 * 60_000);
  });
});

describe("drainMemoryIngestOutbox", () => {
  it("defers on a plan limit: no entry fails, the pass halts after one call, and it resumes after the reset", async () => {
    const time = clock("2026-10-04T20:00:00Z");
    const store = createInMemoryMemoryIngestStore();
    await seed(store, time.now(), 3);
    const { engine, calls } = scriptedEngine([
      () => {
        throw httpError(500, PLAN_LIMIT_DETAIL);
      },
    ]);

    const first = await drainMemoryIngestOutbox({ store, engine, now: time.now, random: () => 0 });

    expect(first).toMatchObject({ claimed: 3, synced: 0, deferred: 3, parked: 0, haltedOn: "plan_limit" });
    // One engine call for the whole pass. No other route was tried.
    expect(calls).toEqual(["rec-1"]);
    const entries = [...store.entries.values()];
    expect(entries.every((entry) => entry.state === "pending")).toBe(true);
    expect(entries.every((entry) => entry.lastErrorKind === "plan_limit")).toBe(true);
    expect(entries.map((entry) => entry.attempts)).toEqual([1, 0, 0]);
    expect(entries.every((entry) => entry.nextAttemptAt.toISOString() === "2026-10-06T09:01:00.000Z")).toBe(true);

    // Before the reset nothing is due.
    time.set(new Date("2026-10-06T09:00:00Z"));
    expect(await drainMemoryIngestOutbox({ store, engine, now: time.now })).toMatchObject({ claimed: 0 });

    time.set(new Date("2026-10-06T09:02:00Z"));
    const resumed = await drainMemoryIngestOutbox({ store, engine, now: time.now });
    expect(resumed).toMatchObject({ claimed: 3, synced: 3, haltedOn: null });
    expect([...store.entries.values()].every((entry) => entry.state === "synced")).toBe(true);
  });

  it("defers on an engine outage with backoff and never fails, however long it lasts", async () => {
    const time = clock("2026-10-04T20:00:00Z");
    const store = createInMemoryMemoryIngestStore();
    await seed(store, time.now(), 1);
    const down: MemoryIngestEngine = {
      async apply() {
        throw connectionRefused();
      },
    };

    let overdueSeen = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await drainMemoryIngestOutbox({ store, engine: down, now: time.now, random: () => 0 });
      expect(result).toMatchObject({ claimed: 1, deferred: 1, haltedOn: "engine_unavailable" });
      overdueSeen += result.overdue.length;
      time.advance(60 * 60_000 + 1);
    }

    const [entry] = store.entries.values();
    expect(entry).toMatchObject({ state: "pending", attempts: 20, lastErrorKind: "engine_unavailable" });
    // Retries are unbounded in time but escalate: attempts 12..20 were reported overdue.
    expect(overdueSeen).toBe(9);

    const up = scriptedEngine([() => ({ usage: { inputTokens: 900, outputTokens: 120 } })]);
    expect(await drainMemoryIngestOutbox({ store, engine: up.engine, now: time.now })).toMatchObject({ synced: 1 });
    expect(entry).toMatchObject({ state: "synced", inputTokens: 900, outputTokens: 120 });
  });

  it("parks a rejected entry for a named owner and keeps going with the rest", async () => {
    const time = clock("2026-10-04T20:00:00Z");
    const store = createInMemoryMemoryIngestStore();
    await seed(store, time.now(), 2);
    const { engine } = scriptedEngine([
      () => {
        throw httpError(422, "content policy refusal");
      },
    ]);

    expect(await drainMemoryIngestOutbox({ store, engine, now: time.now })).toMatchObject({ parked: 1, synced: 1 });
    expect(store.entries.get("outbox-1")).toMatchObject({ state: "needs_attention", lastErrorKind: "rejected" });
  });

  it("re-claims an entry whose worker died mid-call, and the stale worker cannot overwrite the outcome", async () => {
    const time = clock("2026-10-04T20:00:00Z");
    const store = createInMemoryMemoryIngestStore();
    await seed(store, time.now(), 1);
    let token = 0;
    const newToken = () => `t${(token += 1)}`;

    const [stale] = await store.claimDue({ now: time.now(), limit: 5, leaseMs: 60_000, newToken });
    expect(await store.claimDue({ now: time.now(), limit: 5, leaseMs: 60_000, newToken })).toHaveLength(0);

    time.advance(60_001);
    const { engine, calls } = scriptedEngine([]);
    expect(await drainMemoryIngestOutbox({ store, engine, now: time.now, newToken })).toMatchObject({ synced: 1 });
    expect(calls).toEqual(["rec-1"]);

    const lateWrite = await store.defer(stale.id, stale.claimToken!, {
      now: time.now(),
      nextAttemptAt: time.now(),
      kind: "transient",
      error: "late",
      countAttempt: true,
    });
    expect(lateWrite).toBe(false);
    expect(store.entries.get(stale.id)?.state).toBe("synced");
  });

  it("does not queue a duplicate when the same entry is enqueued twice", async () => {
    const store = createInMemoryMemoryIngestStore();
    const now = new Date("2026-10-04T20:00:00Z");
    await seed(store, now, 1);
    await seed(store, now, 1);
    expect(store.entries.size).toBe(1);
  });
});

describe("getDailyPlanUsage", () => {
  it("sums engine token use per Europe/London day and counts chunks-mode deliveries as no model call", async () => {
    const time = clock("2026-10-04T22:30:00Z"); // 23:30 in London (BST)
    const store = createInMemoryMemoryIngestStore();
    await seed(store, time.now(), 3);
    const { engine } = scriptedEngine([
      () => ({ usage: { inputTokens: 1000, outputTokens: 200 } }),
      () => ({ usage: null }),
    ]);
    await drainMemoryIngestOutbox({ store, engine, now: time.now, limit: 2 });
    time.advance(60 * 60_000); // 00:30 London, next day
    const late = scriptedEngine([() => ({ usage: { inputTokens: 500, outputTokens: 50 } })]);
    await drainMemoryIngestOutbox({ store, engine: late.engine, now: time.now });

    expect(await getDailyPlanUsage({ store, companyId: COMPANY, days: 7, now: time.now() })).toEqual([
      { date: "2026-10-04", modelCalls: 1, deliveries: 2, inputTokens: 1000, outputTokens: 200 },
      { date: "2026-10-05", modelCalls: 1, deliveries: 1, inputTokens: 500, outputTokens: 50 },
    ]);
  });
});
