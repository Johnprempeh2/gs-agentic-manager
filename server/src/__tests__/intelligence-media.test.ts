import { describe, expect, it, vi } from "vitest";
import { extractOgImage, guardedMediaFetch, intelligenceMediaService, logoDevUrl, type MediaFetch } from "../services/intelligence-media.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("extractOgImage", () => {
  const page = "https://news.example.com/2026/10/12/story/";

  it("reads og:image in either attribute order and decodes entities", () => {
    expect(extractOgImage(`<head><meta property="og:image" content="https://cdn.example.com/a.jpg?w=1&amp;h=2"></head>`, page))
      .toBe("https://cdn.example.com/a.jpg?w=1&h=2");
    expect(extractOgImage(`<meta content='https://cdn.example.com/b.png' property='og:image' />`, page)).toBe("https://cdn.example.com/b.png");
  });

  it("prefers og:image over twitter:image and falls back to twitter:image", () => {
    const both = `<meta name="twitter:image" content="https://cdn.example.com/t.jpg"><meta property="og:image" content="https://cdn.example.com/o.jpg">`;
    expect(extractOgImage(both, page)).toBe("https://cdn.example.com/o.jpg");
    expect(extractOgImage(`<meta name="twitter:image" content="https://cdn.example.com/t.jpg">`, page)).toBe("https://cdn.example.com/t.jpg");
  });

  it("resolves relative and protocol-relative URLs against the page", () => {
    expect(extractOgImage(`<meta property="og:image" content="/img/hero.webp">`, page)).toBe("https://news.example.com/img/hero.webp");
    expect(extractOgImage(`<meta property="og:image" content="hero.webp">`, page)).toBe("https://news.example.com/2026/10/12/story/hero.webp");
    expect(extractOgImage(`<meta property="og:image" content="//cdn.example.com/x.jpg">`, page)).toBe("https://cdn.example.com/x.jpg");
  });

  it("ignores pages with no preview image and non-http schemes", () => {
    expect(extractOgImage(`<meta name="description" content="hello">`, page)).toBeNull();
    expect(extractOgImage(`<meta property="og:image" content="javascript:alert(1)">`, page)).toBeNull();
    expect(extractOgImage(`<meta property="og:image" content="data:image/png;base64,AAA">`, page)).toBeNull();
  });
});

describe("intelligence media service", () => {
  it("serves no logo, and fetches nothing, when no Logo.dev key is set", async () => {
    const fetchImpl = vi.fn<MediaFetch>();
    const media = intelligenceMediaService({ fetchImpl, logoKey: () => undefined });
    expect(await media.logo("anthropic.com")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks Logo.dev for a png with the key, caches it, and refuses a bad domain", async () => {
    const fetchImpl = vi.fn<MediaFetch>(async () => png());
    const media = intelligenceMediaService({ fetchImpl, logoKey: () => "pk_test" });
    expect((await media.logo("Anthropic.com"))?.contentType).toBe("image/png");
    await media.logo("anthropic.com");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe(logoDevUrl("anthropic.com", "pk_test"));
    expect(fetchImpl.mock.calls[0]![0].searchParams.get("format")).toBe("png");
    expect(await media.logo("../etc/passwd")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves a page's og:image, following a redirect, and caches the result", async () => {
    const fetchImpl = vi.fn<MediaFetch>(async (url) => {
      if (url.pathname === "/old") return new Response(null, { status: 301, headers: { location: "/story" } });
      if (url.pathname === "/story") return html(`<meta property="og:image" content="/hero.png">`);
      if (url.pathname === "/hero.png") return png();
      return new Response("nope", { status: 404 });
    });
    const media = intelligenceMediaService({ fetchImpl });
    const found = await media.image("https://news.example.com/old");
    expect(found?.body.equals(PNG)).toBe(true);
    await media.image("https://news.example.com/old");
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual(["/old", "/story", "/hero.png"]);
  });

  it("refuses non-images, oversized images and pages without a preview", async () => {
    const big = new Response(Buffer.alloc(3 * 1024 * 1024), { headers: { "content-type": "image/png" } });
    const responses: Record<string, () => Response> = {
      "/svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      "/big": () => big,
      "/bare": () => html("<title>No preview</title>"),
    };
    const media = intelligenceMediaService({ fetchImpl: async (url) => responses[url.pathname]!() });
    expect(await media.image("https://x.example.com/svg")).toBeNull();
    expect(await media.image("https://x.example.com/big")).toBeNull();
    expect(await media.image("https://x.example.com/bare")).toBeNull();
  });

  it("refuses private and local addresses through the real guard, including an og:image that points inside", async () => {
    const codes: string[] = [];
    const recording: MediaFetch = async (url, accept, signal) => {
      try {
        return await guardedMediaFetch(url, accept, signal);
      } catch (error) {
        codes.push((error as { code?: string }).code ?? "other");
        throw error;
      }
    };
    const media = intelligenceMediaService({ fetchImpl: recording });
    const inside = ["http://127.0.0.1/a.png", "https://localhost/a.png", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"];
    for (const url of inside) expect(await media.image(url)).toBeNull();
    expect(codes).toEqual(inside.map(() => "remote_http_private_endpoint"));

    // A public page whose og:image names a private host: the second hop goes back through the guard.
    codes.length = 0;
    const pointsInside = intelligenceMediaService({
      fetchImpl: async (url, accept, signal) =>
        url.hostname === "news.example.com" ? html(`<meta property="og:image" content="http://192.168.1.1/x.png">`) : recording(url, accept, signal),
    });
    expect(await pointsInside.image("https://news.example.com/story")).toBeNull();
    expect(codes).toEqual(["remote_http_private_endpoint"]);
  });
});
