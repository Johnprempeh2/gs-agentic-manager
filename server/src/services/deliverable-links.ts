import { isIP } from "node:net";
import { logger } from "../middleware/logger.js";
import { isAlwaysDeniedLinkLocalIp, isPrivateOrReservedIp, resolveApprovedRemoteHttpAddresses } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

// Link deliverables: a live site instead of a stored file. The server checks
// each site daily and keeps one static screenshot for its card. Both go
// through the private-network guard, so a link can never make the server
// fetch or photograph an internal address.

const MAX_REDIRECTS = 5;
const SCREENSHOT_VIEWPORT = { width: 1280, height: 720 };
const SCREENSHOT_NAVIGATION_TIMEOUT_MS = 20_000;
const SCREENSHOT_SETTLE_MS = 1_000;

const guardError = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * What a final HTTP status means for a link deliverable. 401 and 403 are a
 * password protected or unlisted site, not a broken one; 429 is a busy one.
 * No status at all (DNS, TLS or connection failure) is broken.
 */
export function classifyLinkStatus(httpStatus: number | null): { ok: boolean; restricted: boolean } {
  if (httpStatus === null) return { ok: false, restricted: false };
  const restricted = httpStatus === 401 || httpStatus === 403;
  return { ok: httpStatus < 400 || restricted || httpStatus === 429, restricted };
}

export type LinkFetch = (url: URL, method: "HEAD" | "GET") => Promise<Response>;

const guardedFetch: LinkFetch = (url, method) =>
  guardedRemoteHttpFetch(url, { method, headers: { "user-agent": "GS Agentic Manager link check" } }, {
    error: guardError,
    connectTimeoutMs: 10_000,
    responseTimeoutMs: 15_000,
  });

/** The final status of a site after redirects, or null when it cannot be reached. */
export async function checkLinkStatus(url: string, fetchImpl: LinkFetch = guardedFetch): Promise<number | null> {
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (current.protocol !== "https:" && current.protocol !== "http:") return null;
      let response = await fetchImpl(current, "HEAD");
      // Some hosts refuse HEAD; ask again with GET and drop the body.
      if (response.status === 405 || response.status === 501) {
        await response.body?.cancel().catch(() => undefined);
        response = await fetchImpl(current, "GET");
      }
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        // Each hop goes back through the guard via fetchImpl.
        current = new URL(location, current);
        continue;
      }
      return response.status;
    }
    return null;
  } catch {
    return null;
  }
}

type Route = { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> };
type Page = {
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { type: "jpeg"; quality: number }): Promise<Buffer>;
};
type Browser = {
  newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<Page> }>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { headless: boolean; args?: string[] }): Promise<Browser> };

let chromiumLoader: Promise<Chromium | null> | null = null;

/**
 * Playwright's Chromium, if this install has it. The repo already depends on
 * @playwright/test (root dev dependency); nothing new is added. A server
 * without it, or without the browser binary, gets null and cards fall back to
 * the placeholder.
 */
function loadChromium(): Promise<Chromium | null> {
  chromiumLoader ??= (async () => {
    for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
      try {
        const mod = (await import(name)) as { chromium?: Chromium; default?: { chromium?: Chromium } };
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium) return chromium;
      } catch {
        // Try the next package name.
      }
    }
    return null;
  })();
  return chromiumLoader;
}

function isBlockedHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && (isPrivateOrReservedIp(host) || isAlwaysDeniedLinkLocalIp(host));
}

/** A JPEG of the site's first screen, or null when no headless browser is available or the capture fails. */
export async function captureSiteScreenshot(url: string): Promise<Buffer | null> {
  try {
    await resolveApprovedRemoteHttpAddresses(new URL(url), {}, guardError);
  } catch {
    return null;
  }
  const chromium = await loadChromium();
  if (!chromium) return null;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
    const context = await browser.newContext({
      viewport: SCREENSHOT_VIEWPORT,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    // ponytail: subresource hosts are checked by name and IP literal only, not
    // re-resolved, so a DNS rebind on a subresource could still reach a private
    // address. Pin through a proxy if links ever come from untrusted parties.
    await page.route("**/*", async (route) => {
      let target: URL;
      try {
        target = new URL(route.request().url());
      } catch {
        await route.abort();
        return;
      }
      const allowed = target.protocol === "data:" || target.protocol === "blob:"
        || ((target.protocol === "https:" || target.protocol === "http:") && !isBlockedHost(target.hostname));
      await (allowed ? route.continue() : route.abort());
    });
    try {
      await page.goto(url, { waitUntil: "load", timeout: SCREENSHOT_NAVIGATION_TIMEOUT_MS });
    } catch {
      // A slow page still has something on screen worth keeping.
    }
    await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
    return await page.screenshot({ type: "jpeg", quality: 70 });
  } catch (err) {
    logger.warn({ err }, "deliverable screenshot capture failed");
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export type SiteScreenshotter = (url: string) => Promise<Buffer | null>;

// One browser at a time: an import of twenty sites must not start twenty Chromiums.
let screenshotQueue: Promise<unknown> = Promise.resolve();

export function enqueueScreenshot<T>(job: () => Promise<T>): Promise<T> {
  const next = screenshotQueue.then(job, job);
  screenshotQueue = next.catch(() => undefined);
  return next;
}
