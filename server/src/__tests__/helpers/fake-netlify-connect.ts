// A mocked Netlify API and site for the website connect check (GRE-2137).
// `site` answers GET /api/v1/sites/:id; `release` answers https://<domain>/_release.

export interface FakeNetlifyConnect {
  /** Status Netlify answers for the site lookup: 200, or 401 / 403 / 404 / 5xx. */
  siteStatus?: number;
  site?: Record<string, unknown>;
  /** The site's `/_release` answer, or "unreachable" when the address does not answer at all. */
  release?: { status: number; body: unknown } | "unreachable";
}

export function fakeNetlifyConnect(options: FakeNetlifyConnect = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, authorization: new Headers(init?.headers).get("authorization") });
    if (href.startsWith("https://api.netlify.com/")) {
      const status = options.siteStatus ?? 200;
      const body = status === 200
        ? options.site ?? { id: "netlify-site", name: "check-site", custom_domain: "www.check.test", ssl_url: "https://www.check.test" }
        : { code: status, message: "Netlify says no" };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (options.release === "unreachable") throw new TypeError("fetch failed");
    const release = options.release ?? {
      status: 200,
      body: { number: 1, engine: { version: "0.2.0", commit: "abc" }, supportedReleaseSchemas: [1], siteContract: 1 },
    };
    const text = typeof release.body === "string" ? release.body : JSON.stringify(release.body);
    return new Response(text, { status: release.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
