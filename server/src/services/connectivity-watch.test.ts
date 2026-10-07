import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectivityProbeUrlsFromEnv,
  connectivityWatcher,
  outageSummary,
  outageTitle,
  probeOutsideConnectivity,
  readConnectivityState,
  readTailscaleState,
  runAfterOutageChecks,
  type AfterOutageCheck,
  type ConnectivityOutage,
} from "./connectivity-watch.js";

const T0 = Date.parse("2026-10-07T13:00:00.000Z"); // 14:00 London (BST)
const STEP = 30_000;

describe("connectivityWatcher", () => {
  let dir: string;
  let stateFile: string;
  let clock: number;
  let online: boolean;
  let afterChecks: ReturnType<typeof vi.fn<(outageStartedAt: Date) => Promise<AfterOutageCheck[]>>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "connectivity-watch-"));
    stateFile = join(dir, "outages.json");
    clock = T0;
    online = true;
    afterChecks = vi.fn(async (_outageStartedAt: Date): Promise<AfterOutageCheck[]> => [{ name: "telegram_api", ok: true, message: "Telegram answers." }]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function watcher() {
    return connectivityWatcher({
      stateFile,
      probe: async () => ({ online, reasons: online ? [] : ["no outside host answered"] }),
      afterChecks,
      now: () => new Date(clock),
      intervalMs: STEP,
    });
  }

  /** Run checks every 30 s for `ms`, collecting closed outages. */
  async function run(w: ReturnType<typeof watcher>, ms: number) {
    const closed: ConnectivityOutage[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
      const outage = await w.tick();
      if (outage) closed.push(outage);
      clock += STEP;
    }
    return closed;
  }

  it("records exactly one outage, with the right times, for 6 minutes offline", async () => {
    const w = watcher();
    await run(w, 2 * 60_000);
    online = false;
    const offlineAt = clock;
    await run(w, 6 * 60_000);
    online = true;
    const backAt = clock;
    const closed = await run(w, 10 * 60_000);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.startedAt).toBe(new Date(offlineAt).toISOString());
    expect(closed[0]!.endedAt).toBe(new Date(backAt).toISOString());
    expect(closed[0]!.endIsApproximate).toBe(false);
    expect(afterChecks).toHaveBeenCalledTimes(1);
    const state = readConnectivityState(stateFile);
    expect(state.outages).toHaveLength(1);
    expect(state.offlineSince).toBeNull();
  });

  it("records nothing for a 1-minute blip", async () => {
    const w = watcher();
    online = false;
    await run(w, 60_000);
    online = true;
    const closed = await run(w, 5 * 60_000);

    expect(closed).toHaveLength(0);
    expect(afterChecks).not.toHaveBeenCalled();
    expect(readConnectivityState(stateFile).outages).toHaveLength(0);
  });

  it("keeps an outage open across a restart and closes it once", async () => {
    online = false;
    await run(watcher(), 3 * 60_000);
    // A new watcher (server restart) reads the same file.
    const closedOffline = await run(watcher(), 3 * 60_000);
    online = true;
    const closed = await run(watcher(), 60_000);

    expect(closedOffline).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(Date.parse(closed[0]!.endedAt) - Date.parse(closed[0]!.startedAt)).toBe(6 * 60_000);
  });

  it("ends the outage at the last offline check when GSAM was stopped meanwhile", async () => {
    const w = watcher();
    online = false;
    await run(w, 6 * 60_000);
    const lastOfflineCheck = clock - STEP;
    clock += 60 * 60_000; // GSAM was off for an hour.
    online = true;
    const closed = await run(w, STEP);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.endedAt).toBe(new Date(lastOfflineCheck).toISOString());
    expect(closed[0]!.endIsApproximate).toBe(true);
  });
});

describe("probeOutsideConnectivity", () => {
  const up = async () => new Response(null, { status: 204 });
  const down = async () => {
    throw new TypeError("fetch failed");
  };

  it("is online when one host answers and Tailscale runs", async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++ === 0 ? down() : up())) as unknown as typeof fetch;
    const result = await probeOutsideConnectivity({ fetch: fetchImpl, urls: ["https://a", "https://b"], tailscale: async () => "online" });
    expect(result).toEqual({ online: true, reasons: [] });
  });

  it("is offline when no host answers", async () => {
    const result = await probeOutsideConnectivity({ fetch: down as unknown as typeof fetch, urls: ["https://a", "https://b"], tailscale: async () => "unavailable" });
    expect(result.online).toBe(false);
    expect(result.reasons).toEqual(["no outside host answered"]);
  });

  it("is offline when Tailscale is not connected", async () => {
    const result = await probeOutsideConnectivity({ fetch: up as unknown as typeof fetch, urls: ["https://a"], tailscale: async () => "offline" });
    expect(result).toEqual({ online: false, reasons: ["Tailscale is not connected"] });
  });
});

describe("readTailscaleState", () => {
  it("reads the backend state", async () => {
    await expect(readTailscaleState(async () => JSON.stringify({ BackendState: "Running", Self: { Online: true } }))).resolves.toBe("online");
    await expect(readTailscaleState(async () => JSON.stringify({ BackendState: "Running", Self: { Online: false } }))).resolves.toBe("offline");
    await expect(readTailscaleState(async () => JSON.stringify({ BackendState: "NeedsLogin" }))).resolves.toBe("offline");
  });

  it("is unavailable when Tailscale is not installed", async () => {
    await expect(readTailscaleState(async () => {
      throw Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
    })).resolves.toBe("unavailable");
  });
});

describe("runAfterOutageChecks", () => {
  it("reports Telegram, the webhook path and a stuck Telegram webhook", async () => {
    const fetchImpl = (async (url: string) =>
      url.startsWith("https://api.telegram.org") ? new Response("", { status: 302 }) : new Response("", { status: 502 })) as unknown as typeof fetch;
    const checks = await runAfterOutageChecks({
      fetch: fetchImpl,
      webhookPublicBaseUrl: "https://gsam.example.ts.net",
      outageStartedAt: new Date(T0),
      telegramWebhooks: async () => [
        { endpointName: "@gs_bot", pendingUpdates: 3, lastErrorAt: new Date(T0 + 60_000).toISOString(), lastErrorMessage: "Connection timed out" },
        { endpointName: "@other_bot", pendingUpdates: 0, lastErrorAt: new Date(T0 + 60_000).toISOString(), lastErrorMessage: "Connection timed out" },
      ],
    });
    expect(checks).toEqual([
      { name: "telegram_api", ok: true, message: "Telegram answers." },
      { name: "webhook_path", ok: false, message: "The public webhook path (Funnel) gives HTTP 502." },
      { name: "telegram_webhook", ok: false, message: "Telegram cannot deliver to @gs_bot: 3 message(s) wait (Connection timed out)." },
      { name: "telegram_webhook", ok: true, message: "Telegram delivers to @other_bot." },
    ]);
  });

  it("skips the webhook path when no public URL is set", async () => {
    const checks = await runAfterOutageChecks({
      fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      outageStartedAt: new Date(T0),
    });
    expect(checks.map((check) => check.name)).toEqual(["telegram_api"]);
  });
});

describe("outage text", () => {
  const outage: ConnectivityOutage = {
    id: "o1",
    startedAt: "2026-10-07T13:02:00.000Z",
    endedAt: "2026-10-07T14:05:00.000Z",
    endIsApproximate: false,
    checks: [
      { name: "telegram_api", ok: true, message: "Telegram answers." },
      { name: "webhook_path", ok: false, message: "The public webhook path (Funnel) does not answer." },
    ],
  };

  it("gives London times", () => {
    expect(outageTitle(outage)).toBe("GSAM was offline from 14:02 to 15:05");
  });

  it("names the runs and what is still broken", () => {
    expect(outageSummary(outage, { failed: 2, retried: 1 })).toBe(
      "GSAM was offline from 14:02 to 15:05, 1 h 3 min, London time. Agent runs in that time: 2 failed, 1 retried. "
        + "Still broken: The public webhook path (Funnel) does not answer.",
    );
  });

  it("says the checks passed when nothing is broken", () => {
    const fine = { ...outage, checks: [outage.checks[0]!] };
    expect(outageSummary(fine, { failed: 0, retried: 0 })).toContain("Checked after: Telegram answers.");
  });
});

describe("connectivityProbeUrlsFromEnv", () => {
  it("uses HTTPS URLs from the environment, else the defaults", () => {
    expect(connectivityProbeUrlsFromEnv({ GSAM_CONNECTIVITY_PROBE_URLS: "https://a, http://b ,https://c" })).toEqual(["https://a", "https://c"]);
    expect(connectivityProbeUrlsFromEnv({})).toHaveLength(2);
  });
});
