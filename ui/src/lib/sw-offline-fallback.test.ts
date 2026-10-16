import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type FetchListener = (event: {
  request: { method: string; url: string; mode: string };
  respondWith: (response: Promise<Response | undefined> | Response) => void;
}) => void;

function loadServiceWorkerFetchListener(overrides: {
  fetch: () => Promise<Response>;
  cachesMatch: (key: unknown) => Promise<Response | undefined>;
}): FetchListener {
  const listeners = new Map<string, (event: unknown) => void>();
  const swSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin: "https://app.example.com" },
  };
  const caches = {
    match: overrides.cachesMatch,
    open: vi.fn(async () => ({ put: vi.fn() })),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  // Offline fallback belongs to a stamped production build. Development
  // leaves Vite requests to the browser instead of intercepting them.
  const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8")
    .replace("__GSAM_BUILD_ID__", "fixture-production");
  new Function("self", "caches", "fetch", "Response", "URL", code)(
    swSelf,
    caches,
    overrides.fetch,
    Response,
    URL,
  );
  const listener = listeners.get("fetch");
  if (!listener) throw new Error("sw.js registered no fetch listener");
  return listener as FetchListener;
}

async function respondTo(
  listener: FetchListener,
  request: { method: string; url: string; mode: string },
): Promise<Response | undefined> {
  let captured: Promise<Response | undefined> | Response | undefined;
  listener({
    request,
    respondWith: (response) => {
      captured = response;
    },
  });
  return await captured;
}

describe("sw.js offline fallback", () => {
  it("serves an uncached retry page for a failed navigation with an empty cache", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    // respondWith must always receive a real Response; resolving undefined
    // fails the navigation with "Failed to convert value to 'Response'".
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(503);
    expect(response!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    const body = await response!.text();
    expect(body).toContain("GS Agentic Manager is offline");
    expect(body).toContain("Reload page");
    expect(body).not.toContain("<html>app shell</html>");
  });

  it("does not replay a legacy cached shell for a failed navigation", async () => {
    const shell = new Response("<html>app shell</html>", { status: 200 });
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async (key) => (key === "/" ? shell : undefined),
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    expect(response!.status).toBe(503);
    expect(response!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    const body = await response!.text();
    expect(body).toContain("GS Agentic Manager is offline");
    expect(body).toContain("Reload page");
    expect(body).not.toContain("<html>app shell</html>");
  });

  it("returns a network-error Response for a failed asset with no cache entry", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/assets/index-abc.js",
      mode: "no-cors",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response!.type).toBe("error");
  });
});

describe("sw.js app shell for starting offline", () => {
  const SHELL = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abcdefgh.js"></script></body></html>';

  function loadWithCacheStorage(fetchImpl: () => Promise<Response>) {
    const stores = new Map<string, Map<string, Response>>();
    const caches = {
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map<string, Response>();
        stores.set(name, store);
        return {
          put: async (key: unknown, response: Response) => {
            store.set(typeof key === "string" ? key : (key as { url: string }).url, response);
          },
          match: async (key: unknown) => store.get(typeof key === "string" ? key : (key as { url: string }).url)?.clone(),
          delete: async () => true,
        };
      },
      match: async () => undefined,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    };
    const listeners = new Map<string, (event: unknown) => void>();
    const swSelf = {
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
      location: { origin: "https://app.example.com" },
    };
    let current = fetchImpl;
    const code = readFileSync(resolve(uiRoot, "public/sw.js"), "utf8").replace("__GSAM_BUILD_ID__", "fixture-production");
    new Function("self", "caches", "fetch", "Response", "URL", code)(swSelf, caches, () => current(), Response, URL);
    return {
      listener: listeners.get("fetch") as FetchListener,
      setFetch: (next: () => Promise<Response>) => { current = next; },
    };
  }

  const navigate = (path: string) => ({ method: "GET", url: `https://app.example.com${path}`, mode: "navigate" });
  const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-cache", ...headers } });

  it("keeps the shell from a page that loaded and starts the app from it with no signal", async () => {
    const sw = loadWithCacheStorage(async () => html(SHELL));
    expect((await respondTo(sw.listener, navigate("/GRE/inbox/mine")))!.status).toBe(200);

    sw.setFetch(() => Promise.reject(new TypeError("network down")));
    const offline = await respondTo(sw.listener, navigate("/GRE/today"));
    expect(offline!.status).toBe(200);
    expect(await offline!.text()).toBe(SHELL);
  });

  it("never keeps a page that is not the empty shell, or one marked private", async () => {
    const sw = loadWithCacheStorage(async () => html("<html><body><h1>Sign in</h1></body></html>"));
    await respondTo(sw.listener, navigate("/login"));
    sw.setFetch(async () => html(SHELL, { "Cache-Control": "private, no-store" }));
    await respondTo(sw.listener, navigate("/GRE/inbox/mine"));

    sw.setFetch(() => Promise.reject(new TypeError("network down")));
    const offline = await respondTo(sw.listener, navigate("/GRE/today"));
    expect(offline!.status).toBe(503);
    expect(await offline!.text()).toContain("GS Agentic Manager is offline");
  });
});
