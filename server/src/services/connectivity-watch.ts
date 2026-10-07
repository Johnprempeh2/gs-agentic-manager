import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * Outside-connectivity watcher (GRE-999). Every round it asks two well-known
 * HTTPS hosts and Tailscale whether this machine can reach the world. When
 * the machine comes back after five minutes or more, it checks Telegram and
 * the public webhook path, then records one outage. The Inbox shows each
 * recorded outage once, and the decision push sends it to the phone once.
 * Blips under five minutes leave nothing behind.
 */

/** Outages shorter than this are blips: nothing is recorded. */
export const MIN_OUTAGE_MS = 5 * 60_000;
export const CONNECTIVITY_CHECK_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const KEEP_OUTAGES = 20;
export const DEFAULT_PROBE_URLS = [
  "https://www.google.com/generate_204",
  "https://one.one.one.one/cdn-cgi/trace",
];
const TELEGRAM_API_URL = "https://api.telegram.org/";

export type AfterOutageCheck = {
  name: "telegram_api" | "webhook_path" | "telegram_webhook";
  ok: boolean;
  /** Plain words for the Inbox card; never a URL with a token in it. */
  message: string;
};

export type ConnectivityOutage = {
  id: string;
  startedAt: string;
  endedAt: string;
  /** True when GSAM itself stopped during the outage, so the end time is the last check that was still offline. */
  endIsApproximate: boolean;
  checks: AfterOutageCheck[];
};

export type ConnectivityState = {
  /** First failed check of the outage in progress, or null when online. */
  offlineSince: string | null;
  lastCheckAt: string | null;
  outages: ConnectivityOutage[];
};

export type ConnectivityProbeResult = {
  online: boolean;
  reasons: string[];
};

export type TelegramWebhookReport = {
  endpointName: string;
  pendingUpdates: number;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
};

const EMPTY_STATE: ConnectivityState = { offlineSince: null, lastCheckAt: null, outages: [] };

/** `GSAM_CONNECTIVITY_PROBE_URLS`: comma-separated HTTPS URLs to use instead of the defaults. */
export function connectivityProbeUrlsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const urls = (env.GSAM_CONNECTIVITY_PROBE_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("https://"));
  return urls.length > 0 ? urls : DEFAULT_PROBE_URLS;
}

export function defaultConnectivityStateFile() {
  return join(resolvePaperclipInstanceRoot({}), "connectivity", "outages.json");
}

export function readConnectivityState(file: string): ConnectivityState {
  try {
    if (!existsSync(file)) return { ...EMPTY_STATE, outages: [] };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ConnectivityState>;
    return {
      offlineSince: typeof parsed.offlineSince === "string" ? parsed.offlineSince : null,
      lastCheckAt: typeof parsed.lastCheckAt === "string" ? parsed.lastCheckAt : null,
      outages: Array.isArray(parsed.outages) ? parsed.outages : [],
    };
  } catch (error) {
    logger.warn({ err: error, file }, "connectivity state unreadable; starting fresh");
    return { ...EMPTY_STATE, outages: [] };
  }
}

function writeConnectivityState(file: string, state: ConnectivityState) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

/** Any HTTP answer counts: a captive portal or 4xx still proves the line is up. */
async function answers(fetchImpl: typeof fetch, url: string) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return { answered: true, status: response.status };
  } catch {
    return { answered: false, status: 0 };
  }
}

type TailscaleState = "online" | "offline" | "unavailable";

/** `tailscale status --json`; "unavailable" when Tailscale is not installed here. */
export function readTailscaleState(
  run: (cmd: string, args: string[]) => Promise<string> = (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    }),
): Promise<TailscaleState> {
  return run("tailscale", ["status", "--json"])
    .then((stdout) => {
      const status = JSON.parse(stdout) as { BackendState?: string; Self?: { Online?: boolean } };
      if (status.BackendState !== "Running") return "offline" as const;
      return status.Self?.Online === false ? "offline" as const : "online" as const;
    })
    .catch((error: NodeJS.ErrnoException) => (error?.code === "ENOENT" ? "unavailable" as const : "offline" as const));
}

/**
 * Offline when both outside hosts give no answer, or when Tailscale is
 * installed and says this node is not connected (John and Ben reach GSAM
 * through Tailscale, so that counts as lost too).
 */
export async function probeOutsideConnectivity(input: {
  fetch?: typeof fetch;
  urls?: string[];
  tailscale?: () => Promise<TailscaleState>;
} = {}): Promise<ConnectivityProbeResult> {
  const fetchImpl = input.fetch ?? fetch;
  const urls = input.urls ?? DEFAULT_PROBE_URLS;
  const [hosts, tailscale] = await Promise.all([
    Promise.all(urls.map((url) => answers(fetchImpl, url))),
    (input.tailscale ?? (() => readTailscaleState()))(),
  ]);
  const reasons: string[] = [];
  if (!hosts.some((host) => host.answered)) reasons.push("no outside host answered");
  if (tailscale === "offline") reasons.push("Tailscale is not connected");
  return { online: reasons.length === 0, reasons };
}

/** After an outage: can GSAM reach Telegram, does the public webhook path answer, and does Telegram still reach the webhook? */
export async function runAfterOutageChecks(input: {
  fetch?: typeof fetch;
  webhookPublicBaseUrl?: string | null;
  telegramWebhooks?: () => Promise<TelegramWebhookReport[]>;
  outageStartedAt: Date;
}): Promise<AfterOutageCheck[]> {
  const fetchImpl = input.fetch ?? fetch;
  const checks: AfterOutageCheck[] = [];

  const telegram = await answers(fetchImpl, TELEGRAM_API_URL);
  checks.push(telegram.answered
    ? { name: "telegram_api", ok: true, message: "Telegram answers." }
    : { name: "telegram_api", ok: false, message: "Telegram does not answer." });

  if (input.webhookPublicBaseUrl) {
    const health = await answers(fetchImpl, `${input.webhookPublicBaseUrl}/api/health`);
    checks.push(health.answered && health.status >= 200 && health.status < 300
      ? { name: "webhook_path", ok: true, message: "The public webhook path (Funnel) answers." }
      : {
          name: "webhook_path",
          ok: false,
          message: health.answered
            ? `The public webhook path (Funnel) gives HTTP ${health.status}.`
            : "The public webhook path (Funnel) does not answer.",
        });
  }

  if (input.telegramWebhooks) {
    try {
      for (const report of await input.telegramWebhooks()) {
        const errorAt = report.lastErrorAt ? Date.parse(report.lastErrorAt) : 0;
        const stuck = report.pendingUpdates > 0 && errorAt >= input.outageStartedAt.getTime();
        checks.push(stuck
          ? {
              name: "telegram_webhook",
              ok: false,
              message: `Telegram cannot deliver to ${report.endpointName}: ${report.pendingUpdates} message(s) wait`
                + `${report.lastErrorMessage ? ` (${report.lastErrorMessage.slice(0, 120)})` : ""}.`,
            }
          : { name: "telegram_webhook", ok: true, message: `Telegram delivers to ${report.endpointName}.` });
      }
    } catch (error) {
      logger.warn({ err: error }, "telegram webhook check after outage failed");
      checks.push({ name: "telegram_webhook", ok: false, message: "Could not ask Telegram about the webhook." });
    }
  }
  return checks;
}

/** Inbox cards for outages that ended within this window. */
export const OUTAGE_CARD_WINDOW_MS = 7 * 24 * 60 * 60_000;
const OUTAGE_TIME_ZONE = "Europe/London";

function clock(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: OUTAGE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function day(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: OUTAGE_TIME_ZONE, day: "numeric", month: "short" }).format(new Date(iso));
}

function minutes(ms: number) {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total} min`;
  const rest = total % 60;
  return rest === 0 ? `${total / 60} h` : `${Math.floor(total / 60)} h ${rest} min`;
}

/** "GSAM was offline from 14:02 to 15:05" (London time; the day is added when the outage crossed midnight). */
export function outageTitle(outage: ConnectivityOutage) {
  const sameDay = day(outage.startedAt) === day(outage.endedAt);
  const from = sameDay ? clock(outage.startedAt) : `${day(outage.startedAt)} ${clock(outage.startedAt)}`;
  const to = sameDay ? clock(outage.endedAt) : `${day(outage.endedAt)} ${clock(outage.endedAt)}`;
  return `GSAM was offline from ${from} to ${to}${outage.endIsApproximate ? " (or later)" : ""}`;
}

export function outageSummary(outage: ConnectivityOutage, runs: { failed: number; retried: number }) {
  const duration = minutes(Date.parse(outage.endedAt) - Date.parse(outage.startedAt));
  const parts = [
    `${outageTitle(outage)}, ${duration}, London time.`,
    outage.endIsApproximate ? "GSAM itself stopped during the outage, so the end time is the last check that was still offline." : null,
    `Agent runs in that time: ${runs.failed} failed, ${runs.retried} retried.`,
  ];
  const broken = outage.checks.filter((check) => !check.ok);
  if (broken.length > 0) {
    parts.push(`Still broken: ${broken.map((check) => check.message).join(" ")}`);
  } else if (outage.checks.length > 0) {
    parts.push(`Checked after: ${outage.checks.map((check) => check.message).join(" ")}`);
  }
  return parts.filter(Boolean).join(" ");
}

export type ConnectivityWatcherOptions = {
  stateFile: string;
  probe: () => Promise<ConnectivityProbeResult>;
  afterChecks: (outageStartedAt: Date) => Promise<AfterOutageCheck[]>;
  now?: () => Date;
  minOutageMs?: number;
  intervalMs?: number;
};

export function connectivityWatcher(options: ConnectivityWatcherOptions) {
  const now = options.now ?? (() => new Date());
  const minOutageMs = options.minOutageMs ?? MIN_OUTAGE_MS;
  const intervalMs = options.intervalMs ?? CONNECTIVITY_CHECK_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** One check. Returns the outage it closed, if any. */
  async function tick(): Promise<ConnectivityOutage | null> {
    const result = await options.probe();
    const at = now();
    const state = readConnectivityState(options.stateFile);
    const lastCheckAt = state.lastCheckAt ? Date.parse(state.lastCheckAt) : null;
    // GSAM was stopped for a while (or the PC slept): the last offline check
    // is all we know about the end of that outage.
    const gap = lastCheckAt !== null && at.getTime() - lastCheckAt > Math.max(3 * intervalMs, 2 * 60_000);
    let closed: ConnectivityOutage | null = null;

    if (!result.online) {
      if (state.offlineSince && gap) {
        closed = await close(state, new Date(lastCheckAt!), true);
      }
      if (!state.offlineSince) {
        state.offlineSince = at.toISOString();
        logger.warn({ reasons: result.reasons }, "outside connectivity lost");
      }
    } else if (state.offlineSince) {
      closed = await close(state, gap ? new Date(lastCheckAt!) : at, gap);
    }
    state.lastCheckAt = at.toISOString();
    writeConnectivityState(options.stateFile, state);
    return closed;
  }

  async function close(state: ConnectivityState, endedAt: Date, endIsApproximate: boolean) {
    const startedAt = new Date(state.offlineSince!);
    state.offlineSince = null;
    const durationMs = endedAt.getTime() - startedAt.getTime();
    if (durationMs < minOutageMs) {
      logger.info({ durationMs }, "outside connectivity back after a short blip");
      return null;
    }
    const checks = await options.afterChecks(startedAt).catch((error) => {
      logger.warn({ err: error }, "after-outage checks failed");
      return [] as AfterOutageCheck[];
    });
    const outage: ConnectivityOutage = {
      id: randomUUID(),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      endIsApproximate,
      checks,
    };
    state.outages = [...state.outages, outage].slice(-KEEP_OUTAGES);
    logger.warn({ outage }, "outside connectivity back after an outage");
    return outage;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick()
        .catch((error) => logger.warn({ err: error }, "connectivity check failed"))
        .finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    tick,
    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
